// Applies the "RD conversão observada" specification to the workspace. Idempotent by name.
// Nothing here publishes or creates a version.
import { readFileSync } from 'node:fs';
import { call, listAll, WS_PATH } from './api.mjs';

const TAG_HTML_PATH = new URL('../../docs/gtm/rd-conversao-observada.html', import.meta.url);
const INIT_ALL_PAGES = '2147479573'; // built-in "Initialization - All Pages"
const FOLDER_TRIGGERS = '41';
const FOLDER_VARS = '44';
const GOOGLE_LABEL_RD_FORM = 'rTTBCMSe24kdEMO7i6lC';

const html = readFileSync(TAG_HTML_PATH, 'utf8');
if (!/rd_conversion_accepted/.test(html)) throw new Error('tag html does not look right');

const log = (...a) => console.log(...a);
const t = (key, value) => ({ type: 'template', key, value });
const b = (key, value) => ({ type: 'boolean', key, value: value ? 'true' : 'false' });
const i = (key, value) => ({ type: 'integer', key, value: String(value) });

// ---- current state
const tags = await listAll(`${WS_PATH}/tags`, 'tag');
const triggers = await listAll(`${WS_PATH}/triggers`, 'trigger');
const variables = await listAll(`${WS_PATH}/variables`, 'variable');
const builtIns = await listAll(`${WS_PATH}/built_in_variables`, 'builtInVariable');
const byName = (list, name) => list.find((x) => x.name === name);

// ---- built-in Click URL
if (!builtIns.some((v) => v.type === 'clickUrl')) {
  await call('POST', `${WS_PATH}/built_in_variables?type=clickUrl`);
  log('built-in enabled: Click URL');
} else log('built-in already on: Click URL');

// ---- variables
async function ensureVariable(spec) {
  const existing = byName(variables, spec.name);
  if (existing) {
    const same = JSON.stringify(existing.parameter) === JSON.stringify(spec.parameter);
    if (same) {
      log(`variable exists: ${spec.name} [${existing.variableId}]`);
      return existing;
    }
    const updated = await call('PUT', `${WS_PATH}/variables/${existing.variableId}?fingerprint=${existing.fingerprint}`, spec);
    Object.assign(existing, updated);
    log(`variable updated: ${spec.name} [${existing.variableId}]`);
    return existing;
  }
  const created = await call('POST', `${WS_PATH}/variables`, spec);
  log(`variable created: ${spec.name} [${created.variableId}]`);
  variables.push(created);
  return created;
}
await ensureVariable({
  name: 'DLV - rd_event_id',
  type: 'v',
  parentFolderId: FOLDER_VARS,
  parameter: [t('name', 'rd_event_id'), i('dataLayerVersion', 2), b('setDefaultValue', false)],
});
await ensureVariable({
  name: 'DLV - rd_identifier',
  type: 'v',
  parentFolderId: FOLDER_VARS,
  parameter: [t('name', 'rd_identifier'), i('dataLayerVersion', 2), b('setDefaultValue', false)],
});
await ensureVariable({
  name: 'DLV - rd_status',
  type: 'v',
  parentFolderId: FOLDER_VARS,
  parameter: [t('name', 'rd_status'), i('dataLayerVersion', 2), b('setDefaultValue', false)],
});
await ensureVariable({
  name: 'Google Ads - RD form conversion',
  type: 'c',
  parentFolderId: FOLDER_VARS,
  parameter: [t('value', GOOGLE_LABEL_RD_FORM)],
});

// ---- triggers
async function ensureTrigger(spec) {
  const existing = byName(triggers, spec.name);
  if (existing) {
    log(`trigger exists: ${spec.name} [${existing.triggerId}]`);
    return existing;
  }
  const created = await call('POST', `${WS_PATH}/triggers`, spec);
  log(`trigger created: ${spec.name} [${created.triggerId}]`);
  triggers.push(created);
  return created;
}
const trigAccepted = await ensureTrigger({
  name: 'CE - rd_conversion_accepted',
  type: 'customEvent',
  parentFolderId: FOLDER_TRIGGERS,
  customEventFilter: [{ type: 'equals', parameter: [t('arg0', '{{_event}}'), t('arg1', 'rd_conversion_accepted')] }],
});
const trigWaClick = await ensureTrigger({
  name: 'Click - WhatsApp (wa.me)',
  type: 'linkClick',
  parentFolderId: FOLDER_TRIGGERS,
  filter: [{ type: 'matchRegex', parameter: [t('arg0', '{{Click URL}}'), t('arg1', 'wa\\.me|api\\.whatsapp\\.com|web\\.whatsapp\\.com')] }],
  autoEventFilter: [{ type: 'matchRegex', parameter: [t('arg0', '{{Page URL}}'), t('arg1', '.*')] }],
  waitForTags: b('waitForTags', true),
  waitForTagsTimeout: t('waitForTagsTimeout', '2000'),
  checkValidation: b('checkValidation', false),
});

// ---- observer tag
const observerName = 'HTML - RD conversão observada';
{
  const existing = byName(tags, observerName);
  const spec = {
    name: observerName,
    type: 'html',
    firingTriggerId: [INIT_ALL_PAGES],
    tagFiringOption: 'oncePerLoad',
    parameter: [t('html', html), b('supportDocumentWrite', false)],
    notes:
      'Wings System 30/09/2026. Envolve fetch/XHR/sendBeacon; empurra rd_conversion_accepted (2xx), rd_conversion_refused ou rd_conversion_unknown com rd_identifier, rd_status e rd_event_id. Substitui "RD - Aviso de conversão (Wings System)", que fica pausada. Fonte: docs/gtm/rd-conversao-observada.html.',
  };
  if (existing) {
    await call('PUT', `${WS_PATH}/tags/${existing.tagId}?fingerprint=${existing.fingerprint}`, spec);
    log(`tag updated: ${observerName} [${existing.tagId}]`);
  } else {
    const created = await call('POST', `${WS_PATH}/tags`, spec);
    log(`tag created: ${observerName} [${created.tagId}]`);
    tags.push(created);
  }
}

// ---- edits to existing tags (full replace: PUT with the current body plus changes)
async function updateTag(name, mutate) {
  const cur = byName(tags, name);
  if (!cur) throw new Error(`tag not found: ${name}`);
  const body = JSON.parse(JSON.stringify(cur));
  for (const k of ['path', 'accountId', 'containerId', 'workspaceId', 'tagId', 'fingerprint', 'tagManagerUrl']) delete body[k];
  mutate(body);
  const updated = await call('PUT', `${WS_PATH}/tags/${cur.tagId}?fingerprint=${cur.fingerprint}`, body);
  Object.assign(cur, updated);
  log(`tag updated: ${name} [${cur.tagId}]`);
}
const setParam = (body, key, value, type = 'template') => {
  body.parameter = (body.parameter || []).filter((p) => p.key !== key);
  body.parameter.push({ type, key, value });
};
const delParam = (body, key) => {
  body.parameter = (body.parameter || []).filter((p) => p.key !== key);
};

// old observer: paused
await updateTag('RD - Aviso de conversão (Wings System)', (x) => {
  x.paused = true;
  x.notes = 'Pausada em 30/09/2026: substituída por "HTML - RD conversão observada" (só conversões aceitas pelo RD).';
});

// Meta Lead: accepted conversions only, with Event ID
await updateTag('Meta Ads - Lead Formulário', (x) => {
  x.firingTriggerId = [trigAccepted.triggerId];
  setParam(x, 'eventId', '{{DLV - rd_event_id}}');
});

// Google Ads lead: accepted only, label "RD form conversion", transaction id = rd_event_id
await updateTag('Google Ads - Enviar formulário de lead', (x) => {
  x.firingTriggerId = [trigAccepted.triggerId];
  setParam(x, 'conversionLabel', '{{Google Ads - RD form conversion}}');
  setParam(x, 'orderId', '{{DLV - rd_event_id}}');
});

// GA4 lead: accepted only, with identifier and event id as parameters
await updateTag('GA4 - lead_rd_station', (x) => {
  x.firingTriggerId = [trigAccepted.triggerId];
  x.parameter = (x.parameter || []).filter((p) => p.key !== 'eventSettingsTable');
  x.parameter.push({
    type: 'list',
    key: 'eventSettingsTable',
    list: [
      { type: 'map', map: [t('parameter', 'rd_identifier'), t('parameterValue', '{{DLV - rd_identifier}}')] },
      { type: 'map', map: [t('parameter', 'rd_event_id'), t('parameterValue', '{{DLV - rd_event_id}}')] },
    ],
  });
});

// GA-4 generate_lead (already paused): keep paused, move off the dead trigger
await updateTag('GA-4 - Envio formulario', (x) => {
  x.paused = true;
  x.firingTriggerId = [trigAccepted.triggerId];
});

// WhatsApp loose click: Meta standard event Contact
await updateTag('Meta Ads - WhatsApp_clique', (x) => {
  x.firingTriggerId = [trigWaClick.triggerId];
  setParam(x, 'eventName', 'standard');
  setParam(x, 'standardEventName', 'Contact');
  delParam(x, 'customEventName');
});
await updateTag('Google Ads - WhatsApp_clique', (x) => {
  x.firingTriggerId = [trigWaClick.triggerId];
});
await updateTag('GA4 - Evento WhatsApp_click', (x) => {
  x.firingTriggerId = [trigWaClick.triggerId];
  // the event name pointed at a data layer variable that no longer exists on a link click ("undefined" in GA4)
  setParam(x, 'eventName', 'whatsapp_click');
});

log('done');
