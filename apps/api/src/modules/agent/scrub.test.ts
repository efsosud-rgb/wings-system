import { describe, expect, it } from 'vitest';
import { scrubDeep, scrubSensitive } from './scrub.js';

describe('what the agent is never shown', () => {
  it.each([
    ['CPF 123.456.789-09 do lead', 'CPF [CPF removido] do lead'],
    ['liga no (11) 91234-5678', 'liga no [telefone removido]'],
    ['whats +55 11 91234-5678', 'whats [telefone removido]'],
    ['+5511912345678', '[telefone removido]'],
    ['fulano@wingscompany.com.br', '[e-mail removido]'],
    ['token EAAGm0PX4ZCpsBAKZCZBexample1234567890', 'token [token removido]'],
    ['sk-or-v1-abcdef0123456789abcdef', '[token removido]'],
    ['Authorization: Bearer abc.def-ghi_jkl012345678', 'Authorization: [token removido]'],
  ])('%s', (input, expected) => {
    expect(scrubSensitive(input)).toBe(expected);
  });

  it('leaves campaign and account ids alone: the agent needs them', () => {
    const text = 'campanha 120252124379960076 na conta 4268586278, R$ 1.234,56 em 2026-09-21';
    expect(scrubSensitive(text)).toBe(text);
  });

  it('scrubs every string in a nested value and keeps the keys', () => {
    expect(
      scrubDeep({ nome: 'Leads SP', nota: ['ligar (11) 91234-5678'], gasto: 1200, vazio: null }),
    ).toEqual({ nome: 'Leads SP', nota: ['ligar [telefone removido]'], gasto: 1200, vazio: null });
  });
});
