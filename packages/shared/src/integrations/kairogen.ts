import type { KairogenPlan } from '../marketing/media-studio.js';

/**
 * The Kairogen connection, as the settings screen sees it.
 *
 * Nothing here can carry a token: the API keeps access and refresh tokens
 * encrypted and hands the browser a state, never a credential. The user code
 * of the device flow is meant to be typed into Kairogen by a person; the
 * `device_code` the server polls with stays on the server.
 */

export const KAIROGEN_CONNECTION_STATES = [
  'not_configured',
  'disconnected',
  'pending',
  'connected',
  'needs_reconnect',
] as const;
export type KairogenConnectionState = (typeof KAIROGEN_CONNECTION_STATES)[number];

export const KAIROGEN_STATE_LABEL: Record<KairogenConnectionState, string> = {
  not_configured: 'Indisponível neste ambiente',
  disconnected: 'Desconectado',
  pending: 'Aguardando autorização no Kairogen',
  connected: 'Conectado',
  needs_reconnect: 'Precisa reconectar',
};

export interface KairogenPendingAuthorization {
  flow: 'device' | 'code';
  /** Device flow: what the person types at `verificationUri`. */
  userCode: string | null;
  verificationUri: string | null;
  /** Device flow: the same address with the code already filled in, when offered. */
  verificationUriComplete: string | null;
  /** Code flow: where the browser is sent to consent. */
  authorizationUrl: string | null;
  expiresAt: string;
  /** Seconds between two checks, as the authorization server asked. */
  intervalSeconds: number;
}

export interface KairogenCredits {
  /** Null when the balance came back in a shape the system does not recognise. */
  balance: number | null;
  /** What Kairogen said, as text, for when `balance` is null. Never a token. */
  raw: string | null;
  checkedAt: string;
}

export interface KairogenTool {
  name: string;
  description: string | null;
  /** JSON Schema of the arguments, as Kairogen publishes it. */
  inputSchema: Record<string, unknown> | null;
}

export interface KairogenStatus {
  state: KairogenConnectionState;
  /** Why the state is what it is, in words for the screen. */
  detail: string | null;
  connectedAt: string | null;
  connectedByName: string | null;
  scopes: string[];
  pending: KairogenPendingAuthorization | null;
  credits: KairogenCredits | null;
  /**
   * The plan the Wings account is on. Kairogen's `estimate_cost` needs it and
   * does not report it, so an Admin Master states it here.
   */
  plan: KairogenPlan;
  /** MCP protocol version the server settled on, once connected. */
  protocolVersion: string | null;
  /** The tools Kairogen offers this account, read live after connecting. */
  tools: KairogenTool[];
}

/** The eight tools this system is built around. Anything else is ignored. */
export const KAIROGEN_TOOLS = [
  'list_models',
  'estimate_cost',
  'get_credits',
  'generate_image',
  'generate_video',
  'animate_from_generation',
  'upscale_image',
  'get_generation',
] as const;
export type KairogenToolName = (typeof KAIROGEN_TOOLS)[number];

/** Safe to repeat: they read. The rest spend credits and are never retried. */
export const KAIROGEN_READ_TOOLS: readonly KairogenToolName[] = [
  'list_models',
  'estimate_cost',
  'get_credits',
  'get_generation',
];

//   GET  /integrations/kairogen            -> { status: KairogenStatus }
//   POST /integrations/kairogen/connect    -> { status }   body: { flow?: 'device' | 'code' }
//   POST /integrations/kairogen/poll       -> { status }   device flow: one check of the token endpoint
//   GET  /integrations/kairogen/callback   -> 302 to the settings page   (code flow)
//   POST /integrations/kairogen/disconnect -> { status }
//   PUT  /integrations/kairogen/plan       -> { status }   body: { plan }
// All need `integrations.manage`, the callback included (it rides the session cookie).

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------

/** Where a library file came from: an upload, or the provider that generated it. */
export const MEDIA_ORIGINS = [
  'kairogen',
  'upload',
  'cloudflare',
  'gemini',
  'higgsfield',
  'mpt',
] as const;
export type MediaOrigin = (typeof MEDIA_ORIGINS)[number];
export const MEDIA_ORIGIN_LABEL: Record<MediaOrigin, string> = {
  upload: 'Enviadas',
  kairogen: 'Geradas no Kairogen',
  cloudflare: 'Geradas na Cloudflare',
  gemini: 'Geradas no Gemini',
  higgsfield: 'Geradas no Higgsfield',
  mpt: 'Geradas no MoneyPrinterTurbo',
};
export const MEDIA_KINDS = ['image', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Ad shapes the library can be filtered by. `other` is anything else. */
export const MEDIA_ASPECTS = ['1:1', '4:5', '9:16', '16:9', 'other'] as const;
export type MediaAspect = (typeof MEDIA_ASPECTS)[number];

/** The nearest ad shape of a picture, within 3%. */
export function mediaAspectOf(width: number | null, height: number | null): MediaAspect {
  if (!width || !height) return 'other';
  const ratio = width / height;
  const shapes: [MediaAspect, number][] = [
    ['1:1', 1],
    ['4:5', 4 / 5],
    ['9:16', 9 / 16],
    ['16:9', 16 / 9],
  ];
  const match = shapes.find(([, value]) => Math.abs(ratio - value) / value <= 0.03);
  return match ? match[0] : 'other';
}

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  origin: MediaOrigin;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  aspect: MediaAspect;
  durationSeconds: number | null;
  /** Generated media only. */
  prompt: string | null;
  model: string | null;
  credits: number | null;
  /** Who it is for: a row of `clients`, Wings Company unless somebody chose another. */
  clientId: string;
  /** That client's name, for the screen. */
  client: string | null;
  /** Optional filing, the seed of the Drive module. */
  folder: string | null;
  tags: string[];
  ownerName: string | null;
  createdAt: string;
  /** Authenticated route that streams the file. Never a public address. */
  downloadPath: string;
  /**
   * The Drive file this asset is, so the Studio can put it on the canvas by
   * id (`wings-drive://`). Null for assets from before the Drive existed.
   */
  driveFileId: string | null;
}

export const MEDIA_MAX_TAGS = 12;
export const MEDIA_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;
export const MEDIA_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'] as const;

//   GET    /media/assets?kind=&origin=&aspect=&tag=&clientId=&q=  -> { assets: MediaAsset[] }   marketing.media.read
//   GET    /media/assets/:id/file                      -> the file                  marketing.media.read
//   POST   /media/assets  (raw body, typed)            -> { asset }                 marketing.media.generate
//   PATCH  /media/assets/:id  { clientId, folder, tags } -> { asset }                 marketing.media.generate
