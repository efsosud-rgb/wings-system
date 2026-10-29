import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { connectFailureText, signupFailureText } from './connect-errors.js';

/** Each way connecting a number can fail says what happened and what to do, in Portuguese. */

const windowError = (errorCode: string | null) =>
  signupFailureText({ ok: false, reason: 'meta_error', detail: null, errorCode });

describe('signupFailureText: Meta’s window ended without the number', () => {
  it.each([
    ['cancelled', /fechada antes do fim.*siga até a última tela/],
    ['denied', /permissões .* não foram aceitas.*aceite todas as permissões/],
    ['other_flow', /outro tipo de conexão.*número que já está no app WhatsApp Business/],
    ['no_account', /não disse qual conta.*conecte de novo/],
    ['no_code', /bloqueou a janela.*libere janelas deste site/],
  ] as const)('%s', (reason, text) => {
    const message = signupFailureText({ ok: false, reason, detail: null });
    expect(message).toMatch(text);
    expect(message).toMatch(/nada foi conectado/i);
  });

  it.each([
    ['4563015', /desatualizado: é preciso a versão 2\.24\.17 ou maior.*atualize o app/],
    ['2655095', /não está no app WhatsApp Business/],
    ['2655048', /não está no app WhatsApp Business/],
    ['3441041', /ligado a outro portfólio.*desligue-o de lá ou use outro número/],
    ['3441049', /ligado a outra plataforma.*espere 15 minutos/],
    ['2655094', /ligado a outra plataforma.*espere 15 minutos/],
    ['3441030', /já está registrado em outra conta/],
    ['2655093', /compartilhada com outro parceiro.*avise o Eric/],
    ['2655049', /compartilhada com outro parceiro/],
    ['2494028', /compartilhada com outro parceiro/],
    ['3441045', /mais tempo de uso no app/],
    ['3441042', /região deste número/],
    ['3441047', /mensagens de marketing/],
    ['2655082', /página do Facebook/],
    ['3441051', /número é inválido/],
    ['2655011', /não está ligado a uma conta do WhatsApp Business/],
    ['2593072', /não existe ou esta conta do Facebook não tem acesso/],
    ['1349246', /não tem permissão no portfólio.*quem administra o portfólio/],
    ['2593037', /código de verificação/],
    ['2593039', /código de verificação/],
    ['2388091', /código de verificação/],
    ['2388093', /código de verificação/],
    ['3441033', /Muitas tentativas/],
    ['3441046', /Muitas tentativas/],
    ['1390006', /Muitas tentativas/],
    ['1675004', /Muitas tentativas/],
    ['1390008', /Muitas tentativas/],
    ['2494158', /Muitas tentativas/],
    ['2388367', /Muitas tentativas/],
    ['2655089', /restrição na Meta.*avise o Eric/],
    ['3441040', /restrição na Meta/],
    ['2388107', /restrição na Meta/],
    ['2859015', /restrição na Meta/],
    ['1357053', /restrição na Meta/],
    ['2859009', /verificação em duas etapas/],
    ['4612001', /verificação em duas etapas/],
    ['2859030', /confirmação de segurança/],
    ['2859043', /confirmação de segurança/],
    ['2136001', /confirmação de segurança/],
  ])('Meta’s code %s', (code, text) => {
    const message = windowError(code);
    expect(message).toMatch(text);
    expect(message).toContain('Nada foi conectado');
    expect(message).not.toContain('passe ao suporte');
  });

  it('an unknown code, or none, gets the generic text with a short code for support', () => {
    expect(windowError('1690062')).toBe(
      'A Meta mostrou um erro na janela e nada foi conectado. Conecte de novo. Se repetir, passe ao suporte o código ES-1690062.',
    );
    expect(windowError(null)).toContain('o código ES-sem-codigo.');
  });
});

describe('connectFailureText: the API refused or could not be reached', () => {
  it('shows the API’s own refusal as it is', () => {
    const message = 'Este número já está conectado em outro cadastro desta lista.';
    expect(connectFailureText(new ApiError(409, { error: 'number_in_use', message }))).toBe(
      message,
    );
  });

  it('an ended session says to log in again', () => {
    expect(
      connectFailureText(
        new ApiError(401, { error: 'session_expired', message: 'Sessão expirada' }),
      ),
    ).toMatch(/sessão no sistema terminou.*entre de novo/);
  });

  it('a crash or a proxy page never shows its text: the generic one, with a code', () => {
    const crash = connectFailureText(
      new ApiError(500, { error: 'Internal Server Error', message: 'relation "x" does not exist' }),
    );
    expect(crash).not.toContain('relation');
    expect(crash).toMatch(/Veja na lista se o número aparece como Conectado/);
    expect(crash).toContain('o código API-500.');
    expect(
      connectFailureText(new ApiError(502, { error: 'bad_response', message: 'x' })),
    ).toContain('o código API-502.');
    expect(connectFailureText(new ApiError(504, {}))).toContain('o código API-504.');
  });

  it('a network failure says to check the list, then connect again', () => {
    expect(connectFailureText(new TypeError('Failed to fetch'))).toMatch(
      /Sem resposta do sistema.*Veja na lista/,
    );
    expect(connectFailureText(new Error('?'))).toContain('o código WEB.');
  });
});
