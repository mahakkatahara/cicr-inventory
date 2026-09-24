import type {
    ApiResponse,
    ApiPaginatedResponse,
    DbUser,
    DbInventoryItem,
    DbBorrowRecord,
    DbAuditLog,
    AuthLoginPayload,
    AuthSignupPayload,
    ProfileUpdatePayload,
    BulkBorrowRequestPayload,
    ReturnRequestPayload,
    BulkReturnRequestPayload
} from './types';

export type { ApiPaginatedResponse };

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export interface RequestOptions extends RequestInit {
    skipAuth?: boolean;
    skip401Redirect?: boolean;
    retries?: number;
}

/**
 * Event listener target for session expiration notifications
 */
export const SESSION_EXPIRED_EVENT = 'cicr:session-expired';

/**
 * Safely parses response body handling non-JSON (HTML 502/503/504) without unhandled syntax errors.
 */
async function parseResponseBody<T = any>(res: Response): Promise<ApiResponse<T>> {
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    if (!text || text.trim().length === 0) {
        if (!res.ok) {
            return {
                status: 'error',
                message: `Server returned HTTP ${res.status}: ${res.statusText || 'Empty response'}`
            };
        }
        return { status: 'success', data: null as any };
    }

    if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) {
                return { status: 'success', data: parsed as any, count: parsed.length };
            }
            if (typeof parsed === 'object' && parsed !== null) {
                if (!parsed.status) {
                    parsed.status = res.ok ? 'success' : 'error';
                }
                return parsed as ApiResponse<T>;
            }
            return { status: 'success', data: parsed };
        } catch (e) {
            console.warn('[API Client] JSON parse error:', e);
        }
    }

    // HTML / Plaintext fallback for Gateway errors or cold-start timeouts
    if (!res.ok) {
        let msg = `Server Error (${res.status})`;
        if (res.status === 502) msg = '502 Bad Gateway: Server cold-starting or temporarily unreachable.';
        else if (res.status === 503) msg = '503 Service Unavailable: High load or database maintenance.';
        else if (res.status === 504) msg = '504 Gateway Timeout: Database request timed out.';
        return { status: 'error', message: msg };
    }

    return { status: 'success', message: text };
}

/**
 * Centralized fetch client with Bearer auth, safe JSON parsing, 401 interceptor, and retry logic.
 */
export async function apiRequest<T = any>(
    endpoint: string,
    options: RequestOptions = {}
): Promise<ApiResponse<T>> {
    const { skipAuth = false, skip401Redirect = false, retries = 0, ...fetchOptions } = options;

    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(fetchOptions.headers as Record<string, string> || {})
    };

    if (!skipAuth) {
        const token = localStorage.getItem('cicr_token');
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
    }

    fetchOptions.headers = headers;

    let attempt = 0;
    const maxAttempts = (fetchOptions.method && fetchOptions.method.toUpperCase() !== 'GET') ? 1 : Math.max(1, retries + 1);
    let lastError: any = null;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const res = await fetch(url, fetchOptions);

            // Handle 401 Session Expiration
            if (res.status === 401 && !skip401Redirect) {
                localStorage.removeItem('cicr_token');
                localStorage.removeItem('cicr_user');
                localStorage.removeItem('cicr_auth');
                localStorage.removeItem('cicr_role');

                window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, {
                    detail: { message: 'Your session has expired. Please sign in again to continue.' }
                }));

                const parsed = await parseResponseBody<T>(res);
                return {
                    status: 'error',
                    message: parsed.message || 'Session expired. Please sign in again.'
                };
            }

            const parsed = await parseResponseBody<T>(res);

            if (res.ok) {
                return parsed;
            }

            // Retry GET requests on 502/503/504 gateway errors
            if (attempt < maxAttempts && [502, 503, 504].includes(res.status)) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
                continue;
            }

            return parsed;
        } catch (err: any) {
            lastError = err;
            console.error(`[API Client] Attempt ${attempt} failed for ${url}:`, err);
            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
                continue;
            }
        }
    }

    return {
        status: 'error',
        message: lastError?.message || 'Network error. Unable to reach backend server.'
    };
}

// ==========================================
// Centralized API Feature Modules
// ==========================================

export const api = {
    // 1. Auth Module
    auth: {
        login: (payload: AuthLoginPayload) =>
            apiRequest<DbUser>('/auth/login', { method: 'POST', body: JSON.stringify(payload), skipAuth: true }),

        register: (payload: AuthSignupPayload) =>
            apiRequest<DbUser>('/auth/register', { method: 'POST', body: JSON.stringify(payload), skipAuth: true }),

        getProfile: () =>
            apiRequest<DbUser>('/auth/profile', { retries: 2 }),

        updateProfile: (payload: ProfileUpdatePayload) =>
            apiRequest<DbUser>('/auth/profile', { method: 'POST', body: JSON.stringify(payload) }),

        forgotPassword: (payload: { identifier?: string; email?: string }) =>
            apiRequest('/auth/forgot-password', { method: 'POST', body: JSON.stringify(payload), skipAuth: true }),

        resetPassword: (payload: { identifier?: string; email?: string; new_password: string; current_password?: string }) =>
            apiRequest('/auth/reset-password', { method: 'POST', body: JSON.stringify(payload), skipAuth: true }),

        getUsers: (force = false) =>
            apiRequest<DbUser[]>(`/auth/admin/users${force ? '?force=true' : ''}`, { retries: 1 }),

        approveUser: (id: string) =>
            apiRequest(`/auth/admin/users/${id}/approve`, { method: 'POST' }),

        rejectUser: (id: string) =>
            apiRequest(`/auth/admin/users/${id}/reject`, { method: 'POST' }),

        updateRole: (id: string, role: 'ADMIN' | 'MEMBER') =>
            apiRequest(`/auth/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) }),

        deleteUser: (id: string) =>
            apiRequest(`/auth/admin/users/${id}`, { method: 'DELETE' })
    },

    // 2. Inventory Module
    inventory: {
        getItems: (force = false) =>
            apiRequest<DbInventoryItem[]>(`/items${force ? '?force=true' : ''}`, { retries: 2 }),

        getItemById: (id: string) =>
            apiRequest<DbInventoryItem>(`/items/${id}`, { retries: 1 }),

        createItem: (itemData: Partial<DbInventoryItem>) =>
            apiRequest<DbInventoryItem>('/items', { method: 'POST', body: JSON.stringify(itemData) }),

        updateItem: (id: string, itemData: Partial<DbInventoryItem>) =>
            apiRequest<DbInventoryItem>(`/items/${id}`, { method: 'PUT', body: JSON.stringify(itemData) }),

        deleteItem: (id: string) =>
            apiRequest(`/items/${id}`, { method: 'DELETE' })
    },

    // 3. Borrow & Loan Module
    borrow: {
        borrowDirect: (payload: { itemId: string; quantity: number; purpose: string; duration_days?: number }) =>
            apiRequest<DbBorrowRecord>('/borrow', { method: 'POST', body: JSON.stringify(payload) }),

        createRequest: (payload: any) =>
            apiRequest('/borrow/request', { method: 'POST', body: JSON.stringify(payload) }),

        createBulkRequest: (payload: BulkBorrowRequestPayload) =>
            apiRequest('/borrow/bulk-request', { method: 'POST', body: JSON.stringify(payload) }),

        getRequests: (force = false) =>
            apiRequest<any[]>(`/borrow/requests${force ? '?force=true' : ''}`, { retries: 1 }),

        approveRequest: (id: string) =>
            apiRequest(`/borrow/requests/${id}/approve`, { method: 'POST' }),

        rejectRequest: (id: string, reason?: string) =>
            apiRequest(`/borrow/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),

        submitReturnRequest: (payload: ReturnRequestPayload) =>
            apiRequest('/borrow/return-request', { method: 'POST', body: JSON.stringify(payload) }),

        submitBulkReturnRequest: (payload: BulkReturnRequestPayload) =>
            apiRequest('/borrow/bulk-return-request', { method: 'POST', body: JSON.stringify(payload) }),

        getHistory: (params?: { page?: number; limit?: number; force?: boolean }) => {
            const query = new URLSearchParams();
            if (params?.page) query.append('page', String(params.page));
            if (params?.limit) query.append('limit', String(params.limit));
            if (params?.force) query.append('force', 'true');
            return apiRequest<DbBorrowRecord[]>(`/borrow/history?${query.toString()}`, { retries: 1 });
        },

        getLedger: (force = false) =>
            apiRequest<DbBorrowRecord[]>(`/borrow/ledger${force ? '?force=true' : ''}`, { retries: 1 }),

        deleteLedgerRecord: (id: string) =>
            apiRequest(`/borrow/ledger/${id}`, { method: 'DELETE' }),

        getAdmins: () =>
            apiRequest<any[]>('/borrow/admins', { retries: 1 })
    },

    // 4. Dashboard & Audit Module
    dashboard: {
        getStats: () =>
            apiRequest('/stats', { retries: 2 }),

        getAuditLogs: (params?: { page?: number; limit?: number; category?: string; search?: string; days?: number }) => {
            const query = new URLSearchParams();
            if (params?.page) query.append('page', String(params.page));
            if (params?.limit) query.append('limit', String(params.limit));
            if (params?.category) query.append('category', params.category);
            if (params?.search) query.append('search', params.search);
            if (params?.days) query.append('days', String(params.days));
            return apiRequest<DbAuditLog[]>(`/audit?${query.toString()}`, { retries: 1 });
        },

        createAudit: (payload: { action: string; description: string; itemId?: string; metadata?: any }) =>
            apiRequest('/audit', { method: 'POST', body: JSON.stringify(payload) }),

        cleanupAudit: () =>
            apiRequest('/audit/cleanup', { method: 'POST' })
    },

    // 5. System Module
    system: {
        getBoteMetrics: () =>
            apiRequest('/system/bote-metrics', { retries: 1 }),

        getSimulateScale: (users: number, borrowsPerUserPerMonth = 2, jobsPerUser = 1) =>
            apiRequest(`/system/simulate-scale?users=${users}&borrowsPerUserPerMonth=${borrowsPerUserPerMonth}&jobsPerUser=${jobsPerUser}`, { retries: 1 })
    }
};
