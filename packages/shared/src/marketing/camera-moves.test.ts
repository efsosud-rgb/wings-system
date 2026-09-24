import { describe, expect, it } from 'vitest';
import {
  CAMERA_GOALS,
  CAMERA_MOVE_IDS,
  CAMERA_MOVES,
  cameraMovesFor,
  promptRoomWith,
  withCameraMove,
} from './camera-moves.js';
import { PROMPT_MAX, agentGenerationProposalSchema } from './media-studio.js';

describe('camera moves catalog', () => {
  it('has every id once, each with a name, a term, advice and a goal', () => {
    expect(CAMERA_MOVES.map((move) => move.id)).toEqual([...CAMERA_MOVE_IDS]);
    for (const move of CAMERA_MOVES) {
      expect(move.name.length).toBeGreaterThan(2);
      expect(move.term).toMatch(/^[A-Za-z0-9 ,/-]+$/);
      expect(move.whenToUse).toMatch(/\.$/);
      expect(move.goals.length).toBeGreaterThan(0);
    }
  });

  it('covers the moves asked for', () => {
    const terms = CAMERA_MOVES.map((move) => move.term);
    for (const term of [
      'drone shot, ascending',
      'orbit 360',
      'whip pan',
      'slow zoom in',
      'crane up',
      'crane down',
      'hyperlapse',
      'push in',
      'pull out',
      'tilt up',
      'tilt down',
      'pan left',
      'pan right',
      'static shot',
      'FPV drone',
      'rack focus',
    ])
      expect(terms).toContain(term);
  });

  it('suggests at least one move for every goal; a façade gets the ascending drone', () => {
    for (const goal of CAMERA_GOALS) expect(cameraMovesFor(goal).length).toBeGreaterThan(0);
    expect(cameraMovesFor('fachada')[0]?.id).toBe('drone_ascending');
  });
});

describe('withCameraMove', () => {
  it('keeps the person text and adds the term at the end', () => {
    expect(withCameraMove('A bakery storefront at dawn', 'drone_ascending')).toBe(
      'A bakery storefront at dawn. Camera movement: drone shot, ascending.',
    );
    expect(withCameraMove('A product on a table.', 'orbit_360')).toBe(
      'A product on a table. Camera movement: orbit 360.',
    );
  });

  it('with no move, gives the prompt back as written', () => {
    expect(withCameraMove('  a shot  ', null)).toBe('a shot');
    expect(withCameraMove('a shot', undefined)).toBe('a shot');
  });

  it('alone, is only the move', () => {
    expect(withCameraMove('', 'static')).toBe('Camera movement: static shot.');
  });

  it('leaves room so the whole prompt fits', () => {
    for (const id of CAMERA_MOVE_IDS) {
      const room = promptRoomWith(id, PROMPT_MAX);
      expect(withCameraMove('x'.repeat(room), id).length).toBeLessThanOrEqual(PROMPT_MAX);
    }
    expect(promptRoomWith(null, PROMPT_MAX)).toBe(PROMPT_MAX);
  });
});

describe('the agent proposal with a camera move', () => {
  const base = {
    kind: 'video' as const,
    provider: 'kairogen' as const,
    model: 'some-video-model',
    prompt: 'A modern franchise storefront on a sunny street, glass facade, people walking by',
    explanation: 'A fachada da franquia, revelada de baixo para cima.',
    aspect: '9:16' as const,
    quantity: 1,
    clientId: '00000000-0000-4000-8000-000000000001',
  };

  it('takes a move from the catalog on a video', () => {
    const parsed = agentGenerationProposalSchema.parse({ ...base, cameraMove: 'drone_ascending' });
    expect(parsed.cameraMove).toBe('drone_ascending');
  });

  it('refuses a move that is not in the catalog', () => {
    expect(agentGenerationProposalSchema.safeParse({ ...base, cameraMove: 'barrel_roll' }).success).toBe(
      false,
    );
  });

  it('refuses a move on an image', () => {
    const result = agentGenerationProposalSchema.safeParse({
      ...base,
      kind: 'image',
      cameraMove: 'orbit_360',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a prompt that the move would push past the limit', () => {
    const result = agentGenerationProposalSchema.safeParse({
      ...base,
      prompt: 'x'.repeat(PROMPT_MAX),
      cameraMove: 'orbit_360',
    });
    expect(result.success).toBe(false);
  });
});
