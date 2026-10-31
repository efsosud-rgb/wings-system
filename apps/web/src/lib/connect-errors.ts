import { ApiError } from '../api/client.js';
import type { SignupOutcome } from './embedded-signup.js';

/**
 * What the person reads when connecting a number fails (docs/whatsapp/conectar-numero.md): what
 * happened and what to do. Meta's window reports its own errors only to the browser, so they are
 * mapped here; the API's refusals already come with their message. Anything unknown gets a short
 * code to pass to support.
 */

type Failure = Exclude<SignupOutcome, { ok: true }>;

const support = (code: string) => `Se repetir, passe ao suporte o código ${code}.`;
/** The API may have saved the connection before failing: the list says whether it did. */
const unsure = (code: string) =>
  `Algo deu errado ao salvar a conexão. Veja na lista se o número aparece como Conectado; se não, conecte de novo. ${support(code)}`;

const LIMIT =
  'Muitas tentativas seguidas na Meta. Nada foi conectado: espere alguns minutos (até uma hora) e conecte de novo.';
const DISCONNECT_FIRST =
  'Este número ainda está ligado a outra plataforma de atendimento. Nada foi conectado: no app WhatsApp Business do celular, desconecte essa plataforma, espere 15 minutos e conecte de novo.';
const NOT_IN_APP =
  'Este número não está no app WhatsApp Business. Nada foi conectado: passe o número para o app WhatsApp Business (2.24.17 ou maior) no celular do dono e conecte de novo.';
const SHARED =
  'Esta conta do WhatsApp já está compartilhada com outro parceiro na Meta. Nada foi conectado: avise o Eric, que decide se ela sai do outro parceiro.';
const SECURITY =
  'A Meta pediu uma confirmação de segurança da conta do Facebook (login novo ou outro aparelho). Nada foi conectado: confirme o acesso no Facebook, espere alguns minutos e conecte de novo.';
const TWO_FACTOR =
  'A Meta exige a verificação em duas etapas na conta do Facebook que entrou na janela. Nada foi conectado: ative-a no Facebook e conecte de novo.';
const RESTRICTED =
  'A conta do WhatsApp ou o portfólio está com restrição na Meta. Nada foi conectado: avise o Eric, que resolve no suporte da Meta.';
const DENIED =
  'A conta que entrou na janela da Meta não tem permissão no portfólio do número. Nada foi conectado: entre com quem administra o portfólio e conecte de novo, aceitando todas as permissões.';
const CODE_FAILED =
  'A Meta não conseguiu mandar ou conferir o código de verificação. Nada foi conectado: espere alguns minutos e conecte de novo.';

/**
 * Meta's codes in the window's ERROR event, from Meta's "Embedded Signup Flow Errors" page: the
 * coexistence ones and those a seller can meet there. The ad, page and naming ones fall to the
 * generic text with their code.
 */
const META_WINDOW: Record<string, string> = {
  // WhatsApp Business app onboarding (coexistence)
  '3441041':
    'Este número está ligado a outro portfólio de empresa na Meta. Nada foi conectado: desligue-o de lá ou use outro número.',
  '3441045':
    'A Meta ainda não aceita este número para manter no celular: ele precisa de mais tempo de uso no app WhatsApp Business. Nada foi conectado: continue usando o número no app e tente de novo mais tarde.',
  '2655095': NOT_IN_APP,
  '2655048': NOT_IN_APP,
  '3441042':
    'A Meta ainda não oferece manter o número no celular na região deste número. Nada foi conectado: use outro número.',
  '2655093': SHARED,
  '2655082':
    'Este número está ligado a uma página do Facebook. Nada foi conectado: desligue o número da página e conecte de novo.',
  '3441049': DISCONNECT_FIRST,
  '2655094': DISCONNECT_FIRST,
  '3441030':
    'Este número já está registrado em outra conta da plataforma da Meta. Nada foi conectado: use outro número ou peça a quem o registrou que o libere.',
  '3441047':
    'Contas que usam as mensagens de marketing da Meta não podem manter o número no celular. Nada foi conectado: avise o Eric.',
  '4563015':
    'O app WhatsApp Business do celular está desatualizado: é preciso a versão 2.24.17 ou maior. Nada foi conectado: atualize o app na loja do celular e conecte de novo.',
  '3441051':
    'A Meta diz que o número é inválido. Nada foi conectado: confira o número no app WhatsApp Business e conecte de novo.',
  '2655011':
    'Este número não está ligado a uma conta do WhatsApp Business. Nada foi conectado: na janela, escolha a conta em que o número está.',
  // shared accounts
  '2655049': SHARED,
  '2494028': SHARED,
  '2593072':
    'A conta do WhatsApp escolhida não existe ou esta conta do Facebook não tem acesso a ela. Nada foi conectado: conecte de novo e escolha a conta do número.',
  // verification code
  '2593037': CODE_FAILED,
  '2593039': CODE_FAILED,
  '2388091': CODE_FAILED,
  '2388093': CODE_FAILED,
  // rate limits
  '3441033': LIMIT,
  '3441046': LIMIT,
  '1390006': LIMIT,
  '1675004': LIMIT,
  '1390008': LIMIT,
  '2494158': LIMIT,
  '2388367': LIMIT,
  // permissions
  '1349246': DENIED,
  // restricted
  '2655089': RESTRICTED,
  '3441040': RESTRICTED,
  '2388107': RESTRICTED,
  '2859015': RESTRICTED,
  '1357053': RESTRICTED,
  // the Facebook login's security checks
  '2859009': TWO_FACTOR,
  '4612001': TWO_FACTOR,
  '2859030': SECURITY,
  '2859043': SECURITY,
  '2136001': SECURITY,
};

const SIGNUP: Record<Exclude<Failure['reason'], 'meta_error'>, string> = {
  cancelled:
    'A janela da Meta foi fechada antes do fim, então nada foi conectado. Clique em "Conectar pela Meta" de novo e siga até a última tela.',
  denied:
    'As permissões pedidas pela Meta não foram aceitas, então nada foi conectado. Conecte de novo e, na janela, aceite todas as permissões.',
  other_flow:
    'A Meta terminou outro tipo de conexão. Nada foi conectado: conecte de novo e, na janela, escolha usar o número que já está no app WhatsApp Business.',
  no_account:
    'A Meta não disse qual conta do WhatsApp foi compartilhada. Nada foi conectado: conecte de novo e siga até a última tela.',
  no_code:
    'A janela da Meta fechou sem autorizar o sistema (ou o navegador bloqueou a janela). Nada foi conectado: libere janelas deste site no navegador e conecte de novo.',
};

/** Meta's window ended without the number connected. */
export function signupFailureText(outcome: Failure): string {
  if (outcome.reason !== 'meta_error') return SIGNUP[outcome.reason];
  const code = outcome.errorCode ?? null;
  return (
    (code && META_WINDOW[code]) ??
    `A Meta mostrou um erro na janela e nada foi conectado. Conecte de novo. ${support(`ES-${code ?? 'sem-codigo'}`)}`
  );
}

/**
 * The API refused or could not be reached. The API's own refusals (a snake_case code with a
 * message) already say what to do; a crash or a proxy page is never shown as it is.
 */
export function connectFailureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return 'Sua sessão no sistema terminou. Nada foi salvo: entre de novo e conecte outra vez.';
    if (/^[a-z_]+$/.test(error.code) && error.code !== 'bad_response' && error.body.message)
      return error.message;
    return unsure(`API-${error.status}`);
  }
  // `fetch` rejects with a TypeError when the network is down: the API may have saved it all the same.
  if (error instanceof TypeError)
    return 'Sem resposta do sistema (internet ou servidor fora do ar). Veja na lista se o número aparece como Conectado; se não, conecte de novo.';
  return unsure('WEB');
}
