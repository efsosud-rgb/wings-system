import { describe, expect, it } from 'vitest';
import { instagramUsernameOf } from './instagram.js';

describe('instagramUsernameOf', () => {
  it('keeps the username, lower case, however it is typed', () => {
    for (const [typed, username] of [
      ['@Marca.Teste', 'marca.teste'],
      ['marca_teste', 'marca_teste'],
      ['  @@marca  ', 'marca'],
      ['https://instagram.com/marca.teste/', 'marca.teste'],
      ['https://www.instagram.com/Empresa.Exemplo/?hl=pt', 'empresa.exemplo'],
      ['http://instagram.com/marca#perfil', 'marca'],
      ['instagram.com/minhamarca', 'minhamarca'],
      ['www.instagram.com/minhamarca', 'minhamarca'],
      ['WWW.Instagram.com/MinhaMarca/', 'minhamarca'],
      ['a'.repeat(30), 'a'.repeat(30)],
    ] as const) {
      expect(instagramUsernameOf(typed), typed).toBe(username);
    }
  });

  it('refuses what Instagram would not take as a username', () => {
    for (const typed of [
      'marca..x',
      'marca.',
      'a'.repeat(31),
      'marca-teste',
      'não tenho',
      '@',
      'https://instagram.com/',
      'instagram.com/',
      '',
      '   ',
    ]) {
      expect(instagramUsernameOf(typed), typed).toBeNull();
    }
    expect(instagramUsernameOf(null)).toBeNull();
    expect(instagramUsernameOf(undefined)).toBeNull();
  });
});
