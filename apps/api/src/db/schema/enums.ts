import { pgEnum } from 'drizzle-orm/pg-core';

export const employeeStatusEnum = pgEnum('employee_status', ['active', 'inactive', 'on_leave']);

export const permissionScopeEnum = pgEnum('permission_scope', ['own', 'sector', 'all']);

export const timeEntryKindEnum = pgEnum('time_entry_kind', ['clock_in', 'clock_out']);

/**
 * Where a time entry came from. Portaria MTP 671/2021 expects every record to
 * be traceable, so the origin is stored with the entry and never inferred.
 */
export const timeEntrySourceEnum = pgEnum('time_entry_source', [
  'login',
  'logout',
  'session_timeout',
  'manual_adjustment',
  'import',
]);

export const adjustmentStatusEnum = pgEnum('adjustment_status', [
  'pending',
  'approved',
  'rejected',
]);

export const holidayScopeEnum = pgEnum('holiday_scope', ['national', 'state', 'city']);

/** One-time credential links: the initial invite, or a password reset. */
export const credentialTokenPurposeEnum = pgEnum('credential_token_purpose', ['invite', 'reset']);
