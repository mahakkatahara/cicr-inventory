import { Request, Response } from 'express';
import { dbRead } from '../../config/database';
import { cacheGetJSON, cacheSetJSON } from '../../config/redis';
import {
  getReplicationStatus,
  syncSupabaseToNeon,
  reconcileNeonToSupabase,
  applyPendingToNeon,
  performRecovery,
} from '../../config/replication';
import { setSimulatedOutage, getDbHealthSnapshot } from '../../config/dbHealth';
import { checkSupabaseHealth } from '../../config/supabasePool';
import {
  buildBoteSnapshot,
  simulateScale,
  DEFAULT_BOTE_CONFIG,
  BoteInputs
} from '../../services/boteService';

const startOfToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfToday = (): Date => {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
};

const countToday = async (from: string, column: string): Promise<number> => {
  const { count } = await dbRead
    .from(from)
    .select('*', { count: 'exact', head: true })
    .gte(column, startOfToday().toISOString());
  return count || 0;
};

const BOTE_METRICS_CACHE_KEY = 'cicr:cache:bote-metrics';
const BOTE_METRICS_CACHE_TTL = 15; // seconds

// GET /api/system/bote-metrics — live capacity, peak-load, latency & memory snapshot
export const getBoteMetrics = async (req: Request, res: Response) => {
  try {
    // Cache the DB-derived inputs (not the snapshot) so generated_at stays fresh.
    let inputs = await cacheGetJSON<BoteInputs>(BOTE_METRICS_CACHE_KEY);

    if (!inputs) {
      const [borrowsToday, returnsToday, activeBorrows, dueToday, totalUsers, items] = await Promise.all([
        countToday('borrow_records', 'borrowed_at'),
        countToday('borrow_records', 'returned_at'),
        dbRead.from('borrow_records').select('*', { count: 'exact', head: true }).eq('status', 'BORROWED'),
        dbRead.from('borrow_records').select('*', { count: 'exact', head: true }).eq('status', 'BORROWED').lt('due_date', endOfToday().toISOString()),
        dbRead.from('users').select('*', { count: 'exact', head: true }),
        dbRead.from('inventory').select('quantity, available_quantity')
      ]);

      inputs = {
        emailsUsedToday: (borrowsToday || 0) + (returnsToday || 0),
        activeBorrows: activeBorrows.count || 0,
        dueTodayEmails: dueToday.count || 0,
        totalUsers: totalUsers.count || 0,
        totalItems: items.data?.length || 0,
        availableQuantity: items.data?.reduce((acc: number, curr: any) => acc + (curr.available_quantity || 0), 0) || 0,
        borrowedQuantity: items.data?.reduce((acc: number, curr: any) => acc + (curr.quantity || 0), 0) || 0
      };

      await cacheSetJSON(BOTE_METRICS_CACHE_KEY, inputs, BOTE_METRICS_CACHE_TTL);
    }

    return res.status(200).json({
      status: 'success',
      data: {
        ...buildBoteSnapshot(inputs),
        inventory: {
          total_items: inputs.totalItems,
          available_quantity: inputs.availableQuantity,
          borrowed_quantity: Math.max(0, inputs.borrowedQuantity - inputs.availableQuantity)
        }
      }
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// GET /api/system/simulate-scale?users=&borrowsPerUserPerMonth=&jobsPerUser=
export const getSimulateScale = async (req: Request, res: Response) => {
  try {
    const rawUsers = Number(req.query.users);
    const rawBorrows = Number(req.query.borrowsPerUserPerMonth ?? 2);
    const rawJobs = Number(req.query.jobsPerUser ?? 1);

    if (!Number.isFinite(rawUsers) || rawUsers < 0) {
      return res.status(400).json({ status: 'error', message: 'Query param "users" is required and must be a non-negative number.' });
    }
    if (!Number.isFinite(rawBorrows) || rawBorrows < 0) {
      return res.status(400).json({ status: 'error', message: '"borrowsPerUserPerMonth" must be a non-negative number.' });
    }
    if (!Number.isFinite(rawJobs) || rawJobs < 0) {
      return res.status(400).json({ status: 'error', message: '"jobsPerUser" must be a non-negative number.' });
    }

    const MAX_USERS = 1_000_000;
    const MAX_BORROWS = 100_000;
    const MAX_JOBS = 10_000;

    const users = Math.min(rawUsers, MAX_USERS);
    const borrowsPerUserPerMonth = Math.min(rawBorrows, MAX_BORROWS);
    const jobsPerUser = Math.min(rawJobs, MAX_JOBS);

    return res.status(200).json({
      status: 'success',
      data: simulateScale({ users, borrowsPerUserPerMonth, jobsPerUser }, DEFAULT_BOTE_CONFIG)
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// ============================================================
// Supabase PRIMARY → Neon SECONDARY replication / failover ops
// ============================================================

// GET /api/system/replication/status
export const getReplicationStatusHandler = async (req: Request, res: Response) => {
  try {
    return res.status(200).json({ status: 'success', data: await getReplicationStatus() });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/system/replication/sync — run a Supabase → Neon snapshot sync now
export const runReplicationSyncHandler = async (req: Request, res: Response) => {
  try {
    const report = await syncSupabaseToNeon();
    return res.status(200).json({ status: 'success', data: report });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/system/replication/reconcile — push secondary-side changes back to the primary
export const runReconcileHandler = async (req: Request, res: Response) => {
  try {
    const appliedToNeon = await applyPendingToNeon();
    const reconcile = await reconcileNeonToSupabase();
    return res.status(200).json({
      status: 'success',
      data: { appliedPendingToNeon: appliedToNeon, reconcile },
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/system/failover/simulate — CONTROLLED outage simulation (routing only)
export const simulateFailoverHandler = async (req: Request, res: Response) => {
  try {
    // Shared via Redis: this flips routing for ALL backend instances, not just
    // the one that received the request. Credentials/config are not touched.
    setSimulatedOutage(true);
    return res.status(200).json({
      status: 'success',
      message:
        'Controlled outage simulation ACTIVE (shared across all instances). Routing now targets Neon SECONDARY. ' +
        'The real Supabase service is NOT down and credentials are unchanged.',
      data: getDbHealthSnapshot(),
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// POST /api/system/failover/recover — verify primary, reconcile, re-sync, resume PRIMARY
export const recoverPrimaryHandler = async (req: Request, res: Response) => {
  try {
    const primaryReachable = await checkSupabaseHealth();
    if (!primaryReachable) {
      return res.status(503).json({
        status: 'error',
        message: 'Supabase PRIMARY is not reachable — refusing to recover to avoid data loss.',
        data: getDbHealthSnapshot(),
      });
    }

    const outcome = await performRecovery('manual');

    if (outcome.success) {
      // Clear any simulated outage so routing returns to PRIMARY.
      setSimulatedOutage(false);
      return res.status(200).json({
        status: 'success',
        message: 'Primary recovery complete. Routing resumed to Supabase PRIMARY.',
        data: { ...outcome, health: getDbHealthSnapshot() },
      });
    }

    if (outcome.skipped) {
      return res.status(409).json({
        status: 'error',
        message: outcome.reason || 'Recovery already in progress.',
        data: getDbHealthSnapshot(),
      });
    }

    return res.status(500).json({
      status: 'error',
      message: outcome.reason || 'Reconciliation failed — remaining on SECONDARY with pending changes preserved.',
      data: { ...outcome, health: getDbHealthSnapshot() },
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
