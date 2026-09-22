/**
 * Shared contract between apps/api and apps/web: RBAC model, validation
 * schemas and helpers both sides must agree on.
 */

export const APP_NAME = 'Wings System';

export * from './ads/agent.js';
export * from './ads/approvals.js';
export * from './ads/campaign-builder.js';
export * from './ads/cockpit.js';
export * from './ads/simulation.js';
export * from './auth/credentials.js';
export * from './auth/schema.js';
export * from './cpf.js';
export * from './employees/schema.js';
export * from './clients.js';
export * from './drive.js';
export * from './integrations/kairogen.js';
export * from './jobs.js';
export * from './marketing/media-studio.js';
export * from './marketing/seo-checklist.js';
export * from './marketing/site-content.js';
export * from './marketing/site-post.js';
export * from './navigation.js';
export * from './rbac/permissions.js';
export * from './rbac/policy.js';
export * from './rbac/roles.js';
export * from './rbac/sectors.js';
export * from './studio.js';
