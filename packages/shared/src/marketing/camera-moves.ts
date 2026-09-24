/**
 * The camera moves a video prompt can ask for. The name and the advice are for
 * the person (Portuguese); `term` is the technical English the video models
 * understand, and it is the only part that goes into the prompt. The form and
 * the editing agent both apply a move through `withCameraMove`, so a chosen
 * move reads the same whichever of the two picked it.
 */

/** What the shot is of, to suggest a move. */
export const CAMERA_GOALS = [
  'fachada',
  'produto',
  'depoimento',
  'ambiente_interno',
  'ambiente_externo',
  'equipe',
  'evento',
  'detalhe',
] as const;
export type CameraGoal = (typeof CAMERA_GOALS)[number];

export const CAMERA_GOAL_LABEL: Record<CameraGoal, string> = {
  fachada: 'fachada',
  produto: 'produto',
  depoimento: 'depoimento',
  ambiente_interno: 'ambiente interno',
  ambiente_externo: 'ambiente externo',
  equipe: 'equipe',
  evento: 'evento',
  detalhe: 'detalhe',
};

export const CAMERA_MOVE_IDS = [
  'drone_ascending',
  'orbit_360',
  'whip_pan',
  'dolly_tracking',
  'slow_zoom_in',
  'crane_up',
  'crane_down',
  'hyperlapse',
  'handheld',
  'push_in',
  'pull_out',
  'tilt_up',
  'tilt_down',
  'pan_left',
  'pan_right',
  'static',
  'fpv_drone',
  'rack_focus',
] as const;
export type CameraMoveId = (typeof CAMERA_MOVE_IDS)[number];

export interface CameraMove {
  id: CameraMoveId;
  /** Portuguese, on the card. */
  name: string;
  /** English, what enters the prompt. */
  term: string;
  /** One sentence: when this move helps. */
  whenToUse: string;
  goals: readonly CameraGoal[];
}

export const CAMERA_MOVES: readonly CameraMove[] = [
  {
    id: 'drone_ascending',
    name: 'Drone subindo',
    term: 'drone shot, ascending',
    whenToUse: 'Revela a fachada e o entorno de baixo para cima, dando porte ao ponto.',
    goals: ['fachada', 'ambiente_externo'],
  },
  {
    id: 'orbit_360',
    name: 'Órbita 360°',
    term: 'orbit 360',
    whenToUse: 'Gira em volta do assunto para mostrá-lo por todos os lados.',
    goals: ['produto', 'fachada'],
  },
  {
    id: 'whip_pan',
    name: 'Chicote (whip pan)',
    term: 'whip pan',
    whenToUse: 'Giro rápido e borrado que serve de transição enérgica entre cenas.',
    goals: ['evento', 'equipe'],
  },
  {
    id: 'dolly_tracking',
    name: 'Travelling',
    term: 'dolly tracking shot',
    whenToUse: 'Acompanha alguém ou percorre um espaço em movimento lateral suave.',
    goals: ['ambiente_interno', 'equipe'],
  },
  {
    id: 'slow_zoom_in',
    name: 'Zoom lento',
    term: 'slow zoom in',
    whenToUse: 'Aproxima devagar para criar atenção e intimidade com quem fala.',
    goals: ['depoimento', 'produto'],
  },
  {
    id: 'crane_up',
    name: 'Grua subindo',
    term: 'crane up',
    whenToUse: 'Sobe a câmera para abrir de um detalhe para o espaço inteiro.',
    goals: ['ambiente_interno', 'evento'],
  },
  {
    id: 'crane_down',
    name: 'Grua descendo',
    term: 'crane down',
    whenToUse: 'Desce do alto até o assunto, como uma chegada ao local.',
    goals: ['fachada', 'ambiente_interno'],
  },
  {
    id: 'hyperlapse',
    name: 'Hyperlapse',
    term: 'hyperlapse',
    whenToUse: 'Comprime o tempo em movimento para mostrar fluxo e rotina do lugar.',
    goals: ['ambiente_externo', 'evento'],
  },
  {
    id: 'handheld',
    name: 'Câmera na mão',
    term: 'handheld camera',
    whenToUse: 'Tremor leve e natural que passa bastidor, verdade e proximidade.',
    goals: ['depoimento', 'equipe'],
  },
  {
    id: 'push_in',
    name: 'Aproximar (push in)',
    term: 'push in',
    whenToUse: 'A câmera avança até o assunto para destacar um momento ou um produto.',
    goals: ['produto', 'detalhe'],
  },
  {
    id: 'pull_out',
    name: 'Afastar (pull out)',
    term: 'pull out',
    whenToUse: 'Recua do detalhe e revela o contexto em volta.',
    goals: ['ambiente_interno', 'detalhe'],
  },
  {
    id: 'tilt_up',
    name: 'Inclinar para cima',
    term: 'tilt up',
    whenToUse: 'Percorre de baixo para cima algo alto, como um prédio ou uma pessoa.',
    goals: ['fachada', 'equipe'],
  },
  {
    id: 'tilt_down',
    name: 'Inclinar para baixo',
    term: 'tilt down',
    whenToUse: 'Desce o olhar do alto até o que importa na cena.',
    goals: ['fachada', 'produto'],
  },
  {
    id: 'pan_left',
    name: 'Panorâmica à esquerda',
    term: 'pan left',
    whenToUse: 'Gira a câmera parada para a esquerda, mostrando o ambiente aos poucos.',
    goals: ['ambiente_interno', 'ambiente_externo'],
  },
  {
    id: 'pan_right',
    name: 'Panorâmica à direita',
    term: 'pan right',
    whenToUse: 'Gira a câmera parada para a direita, mostrando o ambiente aos poucos.',
    goals: ['ambiente_interno', 'ambiente_externo'],
  },
  {
    id: 'static',
    name: 'Câmera parada',
    term: 'static shot',
    whenToUse: 'Sem movimento, para quem fala ou para o produto ser o único foco.',
    goals: ['depoimento', 'produto'],
  },
  {
    id: 'fpv_drone',
    name: 'Drone FPV',
    term: 'FPV drone',
    whenToUse: 'Voo rápido e contínuo que atravessa o espaço, de fora para dentro.',
    goals: ['ambiente_interno', 'fachada'],
  },
  {
    id: 'rack_focus',
    name: 'Troca de foco',
    term: 'rack focus',
    whenToUse: 'Passa o foco de um plano para outro, levando o olhar ao detalhe.',
    goals: ['detalhe', 'produto'],
  },
];

export const cameraMoveById = (id: string): CameraMove | undefined =>
  CAMERA_MOVES.find((move) => move.id === id);

/** The moves that suit a goal, in catalog order. */
export const cameraMovesFor = (goal: CameraGoal): CameraMove[] =>
  CAMERA_MOVES.filter((move) => move.goals.includes(goal));

/** What `withCameraMove` appends to a prompt. */
export const cameraMoveSuffix = (move: CameraMove): string => `Camera movement: ${move.term}.`;

/**
 * The person's prompt with the move added at the end. The person's text is
 * kept as written; removing the move is not calling this.
 */
export function withCameraMove(prompt: string, id: CameraMoveId | null | undefined): string {
  const base = prompt.trim();
  const move = id ? cameraMoveById(id) : undefined;
  if (!move) return base;
  const suffix = cameraMoveSuffix(move);
  if (base === '') return suffix;
  return /[.!?]$/.test(base) ? `${base} ${suffix}` : `${base}. ${suffix}`;
}

/** How long the person's own prompt may be when a move is added, so the whole fits in `max`. */
export const promptRoomWith = (id: CameraMoveId | null | undefined, max: number): number => {
  const move = id ? cameraMoveById(id) : undefined;
  return move ? max - cameraMoveSuffix(move).length - 2 : max;
};
