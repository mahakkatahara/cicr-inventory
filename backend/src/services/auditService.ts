import { dbWrite } from '../config/database';

export interface AuditEventPayload {
  action: string;
  userId?: string | null;
  itemId?: string | null;
  borrowRecordId?: string | null;
  description: string;
  metadata?: Record<string, unknown> | null;
  severity?: 'info' | 'success' | 'warning' | 'danger';
}

/**
 * Persists an event to the public.audit_logs table.
 * Guaranteed not to throw or block the caller.
 */
export const logAuditEvent = async ({
  action,
  userId,
  itemId,
  borrowRecordId,
  description
}: AuditEventPayload): Promise<void> => {
  try {
    const isUUID = (str?: string | null) => Boolean(str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str));
    const payload: Record<string, any> = {
      action,
      user_id: isUUID(userId) ? userId : null,
      item_id: isUUID(itemId) ? itemId : null,
      description: description || 'System Event',
      timestamp: new Date().toISOString()
    };
    if (isUUID(borrowRecordId)) {
      payload.borrow_record_id = borrowRecordId;
    }

    const { error } = await dbWrite.from('audit_logs').insert([payload]);

    if (error) {
      console.warn('[AUDIT SERVICE] Supabase write error:', error.message);
    }
  } catch (err: any) {
    console.warn('[AUDIT SERVICE] Exception while writing audit log:', err?.message || err);
  }
};
