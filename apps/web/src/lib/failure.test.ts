import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { failureReason } from './failure.js';

/** The reason a screen gives when it has nothing to show (instead of an invented empty state). */
describe('failureReason', () => {
  it.each([
    [401, 'sua sessão expirou'],
    [403, 'você não tem permissão para ver isto'],
    [404, 'não foi encontrado'],
    [429, 'muitas consultas seguidas, tente de novo em instantes'],
    [500, 'o servidor teve um problema (erro 500)'],
    [502, 'o servidor teve um problema (erro 502)'],
    [503, 'o servidor teve um problema (erro 503)'],
  ])('a %i says %s', (status, reason) => {
    expect(failureReason(new ApiError(status, {}))).toBe(reason);
  });

  it('uses the API message for a refusal it explains itself', () => {
    expect(failureReason(new ApiError(422, { message: 'Período inválido.' }))).toBe(
      'Período inválido.',
    );
  });

  it('names an answer the system could not read', () => {
    expect(failureReason(new ApiError(200, { error: 'bad_response' }))).toBe(
      'o servidor respondeu algo inesperado',
    );
  });

  it('a network failure (fetch rejects with a TypeError) is a lost connection', () => {
    expect(failureReason(new TypeError('Failed to fetch'))).toBe('sem conexão com o servidor');
  });

  it('never echoes the text of an unknown error', () => {
    expect(failureReason(new Error('SELECT * FROM leads WHERE phone = 5511999990000'))).toBe(
      'erro inesperado',
    );
    expect(failureReason('boom')).toBe('erro inesperado');
    expect(failureReason(undefined)).toBe('erro inesperado');
  });
});
