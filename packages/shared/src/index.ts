/**
 * Shared contract between apps/api and apps/web: RBAC model, validation
 * schemas and helpers both sides must agree on.
 */

export const APP_NAME = 'Wings System';

export * from './ads/agent.js';
export * from './ads/approvals.js';
export * from './ads/campaign-builder.js';
export * from './ads/cockpit.js';
export * from './ads/dashboard.js';
export * from './ads/insights.js';
export * from './ads/lead-form.js';
export * from './ads/simulation.js';
export * from './ads/verdicts.js';
export * from './ads/youtube-templates.js';
export * from './auth/credentials.js';
export * from './auth/schema.js';
export * from './cpf.js';
export * from './employees/schema.js';
export * from './clients.js';
export * from './client-record.js';
export * from './cnpj.js';
export * from './drive.js';
export * from './integrations/kairogen.js';
export * from './jobs.js';
export * from './leads.js';
export * from './crm.js';
export * from './instagram-check.js';
export * from './lead-fields.js';
export * from './instagram.js';
export * from './sales-panel.js';
export * from './crm-automations.js';
export * from './csv.js';
export * from './calendar.js';
export * from './campaign-leads.js';
export * from './marketing/camera-moves.js';
export * from './marketing/media-providers.js';
export * from './marketing/media-studio.js';
export * from './marketing/owned-channels.js';
export * from './marketing/seo-checklist.js';
export * from './marketing/site-content.js';
export * from './marketing/site-post.js';
export * from './marketing/youtube-channel.js';
export * from './navigation.js';
export * from './office.js';
export * from './projects.js';
export * from './prospecting.js';
export * from './rbac/permissions.js';
export * from './rbac/policy.js';
export * from './rbac/roles.js';
export * from './rbac/sectors.js';
export * from './roadmap.js';
export * from './studio.js';
export * from './studio-agent.js';
export * from './meetings.js';
export * from './whatsapp.js';
export * from './whatsapp-art.js';
export * from './whatsapp-numbers.js';
export * from './whatsapp-templates.js';
export * from './sofia.js';
export * from './whatsapp-inbox.js';
export * from './whatsapp-attendance.js';
