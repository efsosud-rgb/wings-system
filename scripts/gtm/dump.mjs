// Reads a workspace in full (tags, triggers, variables, built-ins, folders) into a JSON file
// and prints a readable summary. Usage: node dump.mjs <out.json>
import { writeFileSync } from 'node:fs';
import { call, listAll, paramMap, WS_PATH } from './api.mjs';

const out = process.argv[2] || 'gtm-dump.json';

const workspace = await call('GET', WS_PATH);
const container = await call('GET', WS_PATH.replace(/\/workspaces\/\d+$/, ''));
const workspaces = await listAll(WS_PATH.replace(/\/\d+$/, ''), 'workspace');
const tags = await listAll(`${WS_PATH}/tags`, 'tag');
const triggers = await listAll(`${WS_PATH}/triggers`, 'trigger');
const variables = await listAll(`${WS_PATH}/variables`, 'variable');
const builtIns = await listAll(`${WS_PATH}/built_in_variables`, 'builtInVariable');
const folders = await listAll(`${WS_PATH}/folders`, 'folder');
const status = await call('GET', `${WS_PATH}/status`);

writeFileSync(
  out,
  JSON.stringify({ container, workspace, workspaces, tags, triggers, variables, builtIns, folders, status }, null, 2),
);

const trigById = Object.fromEntries(triggers.map((t) => [t.triggerId, t.name]));
const tname = (ids) => (ids || []).map((id) => trigById[id] || `#${id}`).join(', ');

console.log(`container ${container.publicId} "${container.name}" workspace ${workspace.workspaceId} "${workspace.name}"`);
console.log(`workspaces: ${workspaces.map((w) => `${w.workspaceId}:${w.name}`).join(' | ')}`);
console.log(`status: changes=${(status.workspaceChange || []).length} conflicts=${(status.mergeConflict || []).length}`);
console.log(`\n== TAGS (${tags.length})`);
for (const t of tags) {
  const p = paramMap(t);
  const bits = [];
  if (t.type === 'html') bits.push(`html ${String(p.html || '').length} chars`);
  if (t.type === 'awct') bits.push(`conv=${p.conversionId}/${p.conversionLabel} txn=${p.transactionId ?? '-'}`);
  if (t.type === 'gaawe') bits.push(`event=${p.eventName}`);
  if (t.type === 'googtag') bits.push(`tagId=${p.tagId}`);
  console.log(
    `- [${t.tagId}] ${t.name} | type=${t.type} | paused=${t.paused ? 'yes' : 'no'} | firing: ${tname(t.firingTriggerId)}${t.blockingTriggerId ? ` | blocking: ${tname(t.blockingTriggerId)}` : ''}${bits.length ? ' | ' + bits.join(' ') : ''}`,
  );
}
console.log(`\n== TRIGGERS (${triggers.length})`);
for (const t of triggers) {
  const ce = paramMap(t);
  const filt = (t.filter || t.customEventFilter || [])
    .map((f) => `${f.type}(${(f.parameter || []).map((x) => x.value).join(' , ')})`)
    .join(' && ');
  console.log(`- [${t.triggerId}] ${t.name} | type=${t.type}${filt ? ` | ${filt}` : ''}`);
}
console.log(`\n== VARIABLES (${variables.length})`);
for (const v of variables) {
  const p = paramMap(v);
  const extra = v.type === 'v' ? ` name=${p.name}` : v.type === 'c' ? ` value=${p.value}` : v.type === 'jsm' ? ` js ${String(p.javascript || '').length} chars` : '';
  console.log(`- [${v.variableId}] ${v.name} | type=${v.type}${extra}`);
}
console.log(`\n== BUILT-INS: ${builtIns.map((b) => b.name).join(', ')}`);
console.log(`\n== FOLDERS: ${folders.map((f) => `${f.folderId}:${f.name}`).join(', ')}`);
