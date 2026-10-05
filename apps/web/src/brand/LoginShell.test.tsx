// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginShell } from './LoginShell.js';

afterEach(cleanup);

describe('LoginShell', () => {
  it('shows the logo and the form it is given, and nothing of its own to submit', () => {
    render(
      <LoginShell title="Entrar" subtitle="Acesse com seu e-mail corporativo">
        <form>
          <button type="submit">Entrar agora</button>
        </form>
      </LoginShell>,
    );
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Wings Company' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
