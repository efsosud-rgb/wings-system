import { GENDER_LABEL } from '@wings/shared';

/** The platforms' own keys for a placement, as the screen names them. */
const PLATFORM_KEY: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  messenger: 'Messenger',
  audience_network: 'Audience Network',
  threads: 'Threads',
  youtube: 'YouTube',
  search: 'Pesquisa Google',
  search_partners: 'Parceiros de pesquisa',
  content: 'Rede de Display',
  mixed: 'Misto',
  unknown: 'Não informado',
};

const POSITION_KEY: Record<string, string> = {
  feed: 'Feed',
  facebook_reels: 'Reels',
  instagram_reels: 'Reels',
  reels: 'Reels',
  facebook_stories: 'Stories',
  instagram_stories: 'Stories',
  stories: 'Stories',
  instagram_explore: 'Explorar',
  instagram_explore_grid_home: 'Explorar',
  instagram_search: 'Busca',
  instagram_profile_feed: 'Perfil',
  marketplace: 'Marketplace',
  video_feeds: 'Vídeos',
  right_hand_column: 'Coluna direita',
  search: 'Busca',
  messenger_inbox: 'Caixa de entrada',
  an_classic: 'Nativo, banner e intersticial',
  rewarded_video: 'Vídeo com recompensa',
  unknown: 'Não informado',
};

function humanise(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (first) => first.toUpperCase());
}

export function placementLabel(key: string, subKey: string): string {
  const platform = PLATFORM_KEY[key] ?? humanise(key);
  if (!subKey) return platform;
  return `${platform} · ${POSITION_KEY[subKey] ?? humanise(subKey)}`;
}

export function ageLabel(key: string): string {
  return key === 'unknown' ? 'Não informada' : key;
}

export function genderLabel(subKey: string): string {
  return GENDER_LABEL[subKey] ?? humanise(subKey);
}

export function hourLabel(key: string): string {
  return `${key}h`;
}

export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Ativa',
  PAUSED: 'Pausada',
  DELETED: 'Excluída',
  ARCHIVED: 'Arquivada',
  // What the platforms report as the delivery status, shown beside "Em veiculação".
  CAMPAIGN_PAUSED: 'Pausada',
  ADSET_PAUSED: 'Conjunto pausado',
  SERVING: 'Ativa',
  ENDED: 'Encerrada',
  WITH_ISSUES: 'Com problemas',
  IN_PROCESS: 'Em processamento',
  PENDING_REVIEW: 'Em análise',
  DISAPPROVED: 'Reprovada',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}
