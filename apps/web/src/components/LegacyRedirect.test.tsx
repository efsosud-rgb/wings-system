import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyRedirect } from './LegacyRedirect.js';

/**
 * Links already sent cannot be edited. The WhatsApp approval message points at
 * the old path with an approval id in it, and a 404 there cost us a stage
 * once already.
 */

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/trafego-pago/aprovacoes/*"
          element={
            <LegacyRedirect
              from="/trafego-pago/aprovacoes"
              to="/marketing/trafego-pago-wings/aprovacoes"
            />
          }
        />
        <Route
          path="/marketing/trafego-pago-wings/aprovacoes"
          element={<div>lista de aprovações</div>}
        />
        <Route
          path="/marketing/trafego-pago-wings/aprovacoes/:id"
          element={<div>aprovação específica</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('old approval links', () => {
  it('carries the approval id through to the new path', () => {
    renderAt('/trafego-pago/aprovacoes/ap-123');
    expect(screen.getByText('aprovação específica')).toBeTruthy();
  });

  it('sends the bare list path to the new list', () => {
    renderAt('/trafego-pago/aprovacoes');
    expect(screen.getByText('lista de aprovações')).toBeTruthy();
  });
});
