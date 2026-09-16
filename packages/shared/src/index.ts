/**
 * Shared contract between apps/api and apps/web.
 *
 * Anything both sides must agree on lives here: role and permission names,
 * Zod schemas for request payloads, and shared enums. Phase 2 fills this in
 * with the real RBAC model; Phase 1 only establishes the package.
 */

export const APP_NAME = 'Wings System';

/** Employment status of an employee record. */
export const EMPLOYEE_STATUS = ['active', 'inactive', 'on_leave'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[number];
