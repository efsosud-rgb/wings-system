import { describe, expect, it } from 'vitest';
import { clientCreateSchema, clientSlugOf, mentionsClient } from './clients.js';
import { WINGS_CLIENT_ID } from './clients.js';
import {
  agentGenerationProposalSchema,
  mediaGenerateSpecSchema,
} from './marketing/media-studio.js';

describe('clients', () => {
  it('makes one slug of a name however it is written', () => {
    expect(clientSlugOf('  Padaria  Aurora ')).toBe('padaria-aurora');
    expect(clientSlugOf('PADARIA AURÓRA')).toBe('padaria-aurora');
    expect(clientCreateSchema.safeParse({ name: '!!' }).success).toBe(false);
  });

  it('finds the client’s name in a text whatever the case, the accents or the punctuation', () => {
    expect(mentionsClient('Storefront of PADARIA-AURÓRA at golden hour', 'Padaria Aurora')).toBe(
      true,
    );
    expect(mentionsClient('A neighborhood bakery at golden hour', 'Padaria Aurora')).toBe(false);
    // Whole words only: "Ana" is not in "banana".
    expect(mentionsClient('a banana on a table', 'Ana')).toBe(false);
  });
});

describe('who a generation is for', () => {
  const spec = {
    operation: 'generate',
    kind: 'image',
    model: 'seedream-v4',
    prompt: 'A neighborhood bakery at golden hour, advertising photography',
    aspect: '1:1',
  };

  it('is Wings Company when the form says nothing', () => {
    expect(mediaGenerateSpecSchema.parse(spec).clientId).toBe(WINGS_CLIENT_ID);
  });

  it('is never assumed for the agent: a proposal without a client is sent back to ask', () => {
    const parsed = agentGenerationProposalSchema.safeParse({
      ...spec,
      provider: 'kairogen',
      prompt: `${spec.prompt}, 35mm, warm window light, clean space for headline`,
      explanation: 'Padaria de bairro no fim da tarde, para o feed.',
      quantity: 1,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('Para qual cliente?');
  });
});
