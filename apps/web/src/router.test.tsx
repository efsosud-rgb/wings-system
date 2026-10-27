import { matchRoutes, type RouteObject } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WhatsAppBulkImportPage } from './pages/crm/WhatsAppBulkImportPage.js';
import { WhatsAppInboxPage } from './pages/crm/WhatsAppInboxPage.js';
import { router } from './router.js';

/** The address of "Importar em lote" (docs/whatsapp/importar-conversa.md) is a child of the WhatsApp module. */

const find = (routes: RouteObject[] | undefined, path: string): RouteObject | undefined =>
  routes?.find((route) => route.path === path);

describe('the WhatsApp routes', () => {
  const shell = find(router.routes, '/');
  const whatsapp = find(shell?.children, 'crm-vendas/whatsapp');

  it('opens the lote import page at /crm-vendas/whatsapp/importar-lote', () => {
    const child = find(whatsapp?.children, 'importar-lote');
    expect(child?.element).toMatchObject({ type: WhatsAppBulkImportPage });
  });

  it('keeps the inbox at the module’s own address', () => {
    const index = whatsapp?.children?.find((route) => route.index);
    expect(index?.element).toMatchObject({ type: WhatsAppInboxPage });
  });

  it('resolves the address to the lote page, not to a conversation called "importar-lote"', () => {
    const matches = matchRoutes(router.routes, '/crm-vendas/whatsapp/importar-lote');
    expect(matches?.at(-1)?.route.element).toMatchObject({ type: WhatsAppBulkImportPage });
    expect(matches?.at(-1)?.params).toEqual({});
  });
});
