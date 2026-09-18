import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioLayout, StudioToolGroup } from './StudioLayout.js';

/**
 * Phase 0 builds the room, not the conversation. These tests pin that the
 * layout is reusable and that the placeholder is honest about the chat not
 * being connected.
 */

afterEach(() => cleanup());

describe('the studio layout', () => {
  it('puts conversation and tools side by side', () => {
    render(
      <StudioLayout
        title="Agente X"
        tools={<StudioToolGroup title="Ações">ferramenta</StudioToolGroup>}
      />,
    );

    expect(screen.getByRole('region', { name: 'Conversa com o agente' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Ferramentas do agente' })).toBeTruthy();
    expect(screen.getByText('ferramenta')).toBeTruthy();
  });

  it('says plainly that the chat is not connected yet', () => {
    render(<StudioLayout title="Agente X" tools={null} />);
    expect(screen.getByText(/O chat ainda não está ligado/)).toBeTruthy();
    // And that the approval gate still applies to anything it proposes.
    expect(screen.getByText(/continuará passando pelo portão de\s+aprovações/)).toBeTruthy();
  });

  it('accepts a real conversation once one exists', () => {
    render(
      <StudioLayout title="Agente X" tools={null} conversation={<div>chat de verdade</div>} />,
    );
    expect(screen.getByText('chat de verdade')).toBeTruthy();
    expect(screen.queryByText(/O chat ainda não está ligado/)).toBeNull();
  });

  it('is the same component for any agent', () => {
    const { unmount } = render(<StudioLayout title="Copywriter" tools={<span>t1</span>} />);
    expect(screen.getByText('Copywriter')).toBeTruthy();
    unmount();

    render(<StudioLayout title="Tráfego Pago" tools={<span>t2</span>} />);
    expect(screen.getByText('Tráfego Pago')).toBeTruthy();
  });
});
