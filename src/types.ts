// Supabase Direct Database Schemas
export interface DbUser {
    id: string;
    name: string;
    email: string;
    roll_number?: string | null;
    username?: string | null;
    batch?: string | null;
    avatar_url?: string | null;
    role: 'ADMIN' | 'MEMBER';
    status?: 'APPROVED' | 'PENDING' | 'REJECTED';
    created_at?: string;
    password_hash?: string;
}

export interface DbInventoryItem {
    id: string;
    name: string;
    category: string;
    total_quantity: number;
    available_quantity: number;
    location?: string | null;
    description?: string | null;
    image?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface DbBorrowRecord {
    id: string;
    user_id?: string | null;
    borrower_name?: string | null;
    roll_number?: string | null;
    inventory_id?: string | null;
    quantity: number;
    purpose?: string | null;
    borrowed_at: string;
    due_date?: string | null;
    returned_at?: string | null;
    status: 'BORROWED' | 'RETURNED' | 'OVERDUE';
    users?: Partial<DbUser> | null;
    inventory?: Partial<DbInventoryItem> | null;
}

export interface DbAuditLog {
    id: string;
    action: string;
    user_id?: string | null;
    item_id?: string | null;
    borrow_record_id?: string | null;
    description: string;
    timestamp: string;
    users?: { name: string; email: string; role: string } | null;
    inventory?: { name: string; category: string } | null;
}

// Standardized API Response Contracts
export interface ApiResponse<T = any> {
    status: 'success' | 'error' | 'pending_approval' | 'rejected';
    message?: string;
    data?: T;
    count?: number;
    token?: string;
    user?: DbUser;
}

export interface ApiPaginatedResponse<T = any> extends ApiResponse<T[]> {
    pagination?: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
}

// Strongly-Typed Request Payloads
export interface BulkBorrowItemInput {
    itemId: string;
    quantity: number;
}

export interface BulkBorrowRequestPayload {
    items: BulkBorrowItemInput[];
    purpose: string;
    durationDays?: number;
    borrowerName?: string;
    borrowerEmail?: string;
    rollNumber?: string;
}

export interface ReturnRequestPayload {
    borrowId: string;
    returnQuantity: number;
    reason?: string;
}

export interface BulkReturnItemInput {
    borrowId: string;
    returnQuantity: number;
}

export interface BulkReturnRequestPayload {
    returns: BulkReturnItemInput[];
}

export interface AuthLoginPayload {
    identifier: string;
    password: string;
    email?: string;
    username?: string;
    name?: string;
}

export interface AuthSignupPayload {
    name: string;
    email: string;
    username: string;
    roll_number: string;
    batch: string;
    password: string;
    confirmPassword?: string;
}

export interface ProfileUpdatePayload {
    name?: string;
    username?: string;
    batch?: string;
    avatar_url?: string;
    profile_pic?: string;
}

// Backward-Compatible View Models for UI Components
export interface BorrowRecord {
    id?: string;
    name: string;
    userName?: string;
    borrowerName?: string;
    roll: string;
    userRoll?: string;
    email?: string;
    userEmail?: string;
    qty: number;
    purpose: string;
    date: string;
    dueDate?: string;
    returned?: boolean;
    returnedAt?: string;
    returnDate?: string;
    status?: string;
    adminApprovedBy?: string;
    approvedBy?: string;
    reviewedBy?: string;
    users?: any;
    inventory?: any;
}

export interface RequestRecord {
    id: string;
    type?: 'ISSUE' | 'RETURN';
    borrowId?: string;
    returnQuantity?: number;
    itemId: string;
    itemName: string;
    name: string;
    roll: string;
    qty: number;
    purpose: string;
    dueDate?: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    requestedAt: string;
    reviewedAt?: string;
    reviewedBy?: string;
    reviewNote?: string;
}

export interface InventoryItem {
    id: string;
    name: string;
    category: string;
    quantity: number;
    availableQuantity?: number;
    location: string;
    specs: string;
    image?: string;
    tags?: string[];
    status?: string;
    borrowedBy: BorrowRecord[];
}

export interface ActivityLog {
    type: 'system' | 'borrow' | 'return' | 'add' | 'request' | 'approve' | 'reject' | 'overdue' | 'low_stock';
    timestamp: string;
    text: string;
}

export interface UserDatabase {
    [username: string]: string; // username -> password mapping
}
