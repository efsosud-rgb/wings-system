import { z } from 'zod';
import {
  STUDIO_ASPECT_KEYS,
  STUDIO_POSITIONS,
  STUDIO_TRANSITIONS,
  type StudioPosition,
} from './studio.js';

/**
 * Studio parte 3 (a): the editing agent edits the timeline by what a person
 * asks for in words, and only through a card.
 *
 * The browser sends a view of the timeline with the message: clip ids, types,
 * times, Drive file ids and names, never a link. The agent answers with a
 * list of operations (`propor_edicao`); the server checks them against that
 * view and stores a card that says, line by line, what would change. The
 * operations run in the browser only when the person clicks "Pré-visualizar",
 * as one step that "Descartar" (or Ctrl+Z) takes back. Nothing here spends
 * credits: generating media stays on the "Gerar (R$ X)" card.
 *
 * Seconds everywhere. A clip id is the editor core's own id for the clip.
 */

export const STUDIO_AGENT_MAX_OPS = 20;
export const STUDIO_TIMELINE_MAX_CLIPS = 80;
export const STUDIO_TIMELINE_MAX_FILES = 80;
/** The shortest clip an operation may leave behind. */
export const STUDIO_MIN_CLIP_SECONDS = 0.1;

export const STUDIO_FILE_KINDS = ['video', 'audio', 'image', 'subtitle'] as const;
export type StudioFileKindName = (typeof STUDIO_FILE_KINDS)[number];

const seconds = z.number().finite().min(0).max(36_000);
const clipIdSchema = z.string().trim().min(1).max(64);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor em #rrggbb');

export const STUDIO_TEXT_TYPES = ['rich-text', 'text', 'title'] as const;
export const STUDIO_CAPTION_TYPES = ['rich-caption', 'caption'] as const;
export const STUDIO_TIMED_MEDIA_TYPES = ['video', 'audio'] as const;
const isText = (type: string) => (STUDIO_TEXT_TYPES as readonly string[]).includes(type);
const isCaption = (type: string) => (STUDIO_CAPTION_TYPES as readonly string[]).includes(type);
const isTimedMedia = (type: string) =>
  (STUDIO_TIMED_MEDIA_TYPES as readonly string[]).includes(type);

// ---------------------------------------------------------------------------
// What the browser sends
// ---------------------------------------------------------------------------

export const studioTimelineClipSchema = z.object({
  id: clipIdSchema,
  /** 0 is the top track, drawn over the others. */
  track: z.number().int().min(0).max(99),
  /** The core's asset type: video, audio, image, rich-text, rich-caption, svg… */
  type: z.string().trim().min(1).max(40),
  /** The Drive file the clip plays, if any. */
  fileId: z.uuid().nullable(),
  /** The Drive file's name, for people and for the agent. */
  name: z.string().max(200).nullable(),
  /** Resolved: `auto` and `end` already turned into seconds. */
  start: seconds,
  length: seconds,
  /** Video and audio: seconds skipped at the start of the file. */
  trim: seconds.nullable(),
  /** Text clips: the words on screen. */
  text: z.string().max(2000).nullable(),
  position: z.enum(STUDIO_POSITIONS).nullable(),
  opacity: z.number().min(0).max(1).nullable(),
  volume: z.number().min(0).max(1).nullable(),
});
export type StudioTimelineClip = z.output<typeof studioTimelineClipSchema>;

export const studioTimelineFileSchema = z.object({
  fileId: z.uuid(),
  name: z.string().max(200),
  mimeType: z.string().max(120),
  kind: z.enum(STUDIO_FILE_KINDS),
});
export type StudioTimelineFile = z.output<typeof studioTimelineFileSchema>;

/** The timeline as the agent may see it. Data, never instructions. */
export const studioTimelineSnapshotSchema = z.object({
  aspect: z.enum(STUDIO_ASPECT_KEYS),
  mode: z.enum(['image', 'video']),
  durationSeconds: seconds,
  playheadSeconds: seconds,
  selectedClipId: clipIdSchema.nullable(),
  clips: z.array(studioTimelineClipSchema).max(STUDIO_TIMELINE_MAX_CLIPS),
  /** Files already in this project, which `add_file` may place again. */
  files: z.array(studioTimelineFileSchema).max(STUDIO_TIMELINE_MAX_FILES),
});
export type StudioTimelineSnapshot = z.output<typeof studioTimelineSnapshotSchema>;

// ---------------------------------------------------------------------------
// What the agent proposes
// ---------------------------------------------------------------------------

const textStyleSchema = z
  .object({
    content: z.string().trim().min(1).max(500).optional(),
    fontFamily: z.string().trim().min(1).max(60).optional(),
    size: z.number().min(8).max(400).optional(),
    color: hexColor.optional(),
  })
  .strict();

const captionStyleSchema = z
  .object({
    fontFamily: z.string().trim().min(1).max(60).optional(),
    size: z.number().min(8).max(400).optional(),
    color: hexColor.optional(),
    placement: z.enum(['bottom', 'middle', 'top']).optional(),
    backgroundColor: hexColor.optional(),
    backgroundOpacity: z.number().min(0).max(1).optional(),
  })
  .strict();

export const STUDIO_TEXT_PRESETS = ['title', 'subtitle', 'body'] as const;

export const studioTimelineOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), clipId: clipIdSchema }).strict(),
  z
    .object({
      op: z.literal('set_timing'),
      clipId: clipIdSchema,
      start: seconds.optional(),
      length: seconds.min(STUDIO_MIN_CLIP_SECONDS).optional(),
      trim: seconds.optional(),
    })
    .strict(),
  z.object({ op: z.literal('split'), clipId: clipIdSchema, at: seconds }).strict(),
  z
    .object({
      op: z.literal('style'),
      clipId: clipIdSchema,
      position: z.enum(STUDIO_POSITIONS).optional(),
      opacity: z.number().min(0).max(1).optional(),
      scale: z.number().min(0.05).max(10).optional(),
      volume: z.number().min(0).max(1).optional(),
      transitionIn: z.enum(STUDIO_TRANSITIONS).optional(),
      transitionOut: z.enum(STUDIO_TRANSITIONS).optional(),
      text: textStyleSchema.optional(),
      caption: captionStyleSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add_text'),
      text: z.string().trim().min(1).max(500),
      preset: z.enum(STUDIO_TEXT_PRESETS).default('title'),
      start: seconds,
      length: seconds.min(STUDIO_MIN_CLIP_SECONDS),
      position: z.enum(STUDIO_POSITIONS).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add_file'),
      /** A file of this project (`files` in the view)… */
      fileId: z.uuid().optional(),
      /** …or a media library item, by the id `consultar_biblioteca` gives. */
      mediaAssetId: z.uuid().optional(),
      start: seconds,
      /** Images: how long on screen (5 s if absent). Video and audio take the file's length. */
      length: seconds.min(STUDIO_MIN_CLIP_SECONDS).optional(),
    })
    .strict(),
]);
export type StudioTimelineOp = z.output<typeof studioTimelineOpSchema>;

/** What `propor_edicao` carries. */
export const agentTimelineEditProposalSchema = z
  .object({
    /** For the person, in Portuguese: what the edit does and why. */
    explanation: z.string().trim().min(1).max(600),
    ops: z.array(studioTimelineOpSchema).min(1).max(STUDIO_AGENT_MAX_OPS),
  })
  .superRefine((proposal, ctx) => {
    proposal.ops.forEach((op, index) => {
      if (op.op === 'add_file' && (op.fileId === undefined) === (op.mediaAssetId === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ops', index],
          message: 'Informe fileId (arquivo do projeto) ou mediaAssetId (biblioteca), um dos dois',
        });
      }
      if (
        op.op === 'set_timing' &&
        op.start === undefined &&
        op.length === undefined &&
        op.trim === undefined
      ) {
        ctx.addIssue({ code: 'custom', path: ['ops', index], message: 'Nada a mudar no tempo' });
      }
      if (op.op === 'style' && Object.keys(op).length <= 2) {
        ctx.addIssue({ code: 'custom', path: ['ops', index], message: 'Nada a mudar no estilo' });
      }
    });
  });
export type AgentTimelineEditProposal = z.output<typeof agentTimelineEditProposalSchema>;

/**
 * The card as stored: the proposal after the server checked it, with every
 * `add_file` pointing at a Drive file id, the files it places, and the lines
 * that say what changes — written by the server, not by the model.
 */
export const storedTimelineEditSchema = z.object({
  explanation: z.string(),
  ops: z.array(studioTimelineOpSchema),
  lines: z.array(z.string()),
  files: z.record(
    z.uuid(),
    z.object({ name: z.string(), mimeType: z.string(), kind: z.enum(STUDIO_FILE_KINDS) }),
  ),
});
export type StoredTimelineEdit = z.output<typeof storedTimelineEditSchema>;

// ---------------------------------------------------------------------------
// Checking and describing, the same on both sides
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<string, string> = {
  video: 'vídeo',
  audio: 'áudio',
  image: 'imagem',
  'rich-text': 'texto',
  text: 'texto',
  title: 'texto',
  svg: 'forma',
  caption: 'legenda',
  'rich-caption': 'legenda',
};

const POSITION_LABEL: Record<StudioPosition, string> = {
  topLeft: 'acima à esquerda',
  top: 'acima',
  topRight: 'acima à direita',
  left: 'à esquerda',
  center: 'no centro',
  right: 'à direita',
  bottomLeft: 'abaixo à esquerda',
  bottom: 'abaixo',
  bottomRight: 'abaixo à direita',
};

const PLACEMENT_LABEL = { bottom: 'terço inferior', middle: 'centro', top: 'terço superior' };

/** "3,5 s" */
export function formatSeconds(value: number): string {
  return `${(Math.round(value * 10) / 10).toLocaleString('pt-BR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} s`;
}

interface SimClip {
  id: string;
  type: string;
  name: string | null;
  text: string | null;
  start: number;
  length: number;
  trim: number | null;
}

function labelOf(clip: SimClip): string {
  const type = TYPE_LABEL[clip.type] ?? clip.type;
  const words = clip.text?.trim()
    ? clip.text.trim().replace(/\s+/g, ' ')
    : (clip.name ?? '').trim();
  const shown = words.length > 40 ? `${words.slice(0, 37)}…` : words;
  const span = `${formatSeconds(clip.start)} a ${formatSeconds(clip.start + clip.length)}`;
  return shown ? `${type} "${shown}" (${span})` : `${type} (${span})`;
}

export interface TimelineCheck {
  /** Reasons the list cannot be applied, one per problem; empty when it can. */
  problems: string[];
  /** One line per operation, in Portuguese, for the card. */
  lines: string[];
}

/**
 * Walks the operations over the view in order, the way the browser will apply
 * them, and says what each one does or why it cannot. A clip removed by an
 * earlier operation is gone for the later ones; a split leaves the first half
 * under the old id.
 */
export function checkTimelineOps(
  ops: StudioTimelineOp[],
  snapshot: Pick<StudioTimelineSnapshot, 'clips'>,
  files: Record<string, { name: string; kind: StudioFileKindName }>,
): TimelineCheck {
  const clips = new Map<string, SimClip>(
    snapshot.clips.map((clip) => [
      clip.id,
      {
        id: clip.id,
        type: clip.type,
        name: clip.name,
        text: clip.text,
        start: clip.start,
        length: clip.length,
        trim: clip.trim,
      },
    ]),
  );
  const problems: string[] = [];
  const lines: string[] = [];

  ops.forEach((op, index) => {
    const at = `operação ${index + 1}`;
    if (op.op === 'add_text') {
      lines.push(
        `Novo texto "${op.text.length > 40 ? `${op.text.slice(0, 37)}…` : op.text}" de ${formatSeconds(op.start)} a ${formatSeconds(op.start + op.length)}${op.position ? `, ${POSITION_LABEL[op.position]}` : ''}`,
      );
      return;
    }
    if (op.op === 'add_file') {
      const file = op.fileId ? files[op.fileId] : undefined;
      if (!file) {
        problems.push(
          `${at}: o arquivo não está neste projeto nem na biblioteca. Use um fileId de "files" ou um mediaAssetId de consultar_biblioteca.`,
        );
        return;
      }
      if (op.length !== undefined && file.kind !== 'image') {
        problems.push(
          `${at}: ${TYPE_LABEL[file.kind] ?? file.kind} entra com a duração do arquivo; para encurtar, use set_timing depois.`,
        );
        return;
      }
      lines.push(
        `Adiciona ${TYPE_LABEL[file.kind === 'subtitle' ? 'caption' : file.kind]} "${file.name}" em ${formatSeconds(op.start)}${op.length !== undefined ? `, por ${formatSeconds(op.length)}` : ''}`,
      );
      return;
    }

    const clip = clips.get(op.clipId);
    if (!clip) {
      problems.push(
        `${at}: o clipe "${op.clipId.slice(0, 64)}" não está na linha do tempo (ou já foi removido por uma operação anterior). Use um id de linha_do_tempo.`,
      );
      return;
    }
    const label = labelOf(clip);

    if (op.op === 'remove') {
      clips.delete(clip.id);
      lines.push(`Remove ${label}`);
      return;
    }

    if (op.op === 'split') {
      const earliest = clip.start + STUDIO_MIN_CLIP_SECONDS;
      const latest = clip.start + clip.length - STUDIO_MIN_CLIP_SECONDS;
      if (op.at < earliest || op.at > latest) {
        problems.push(
          `${at}: ${formatSeconds(op.at)} fica fora de ${label}; o corte tem de cair dentro do clipe.`,
        );
        return;
      }
      lines.push(`Divide ${label} em ${formatSeconds(op.at)}`);
      clip.length = op.at - clip.start;
      return;
    }

    if (op.op === 'set_timing') {
      if (op.trim !== undefined && !isTimedMedia(clip.type)) {
        problems.push(`${at}: só vídeo e áudio têm início do arquivo (trim); ${label} não.`);
        return;
      }
      const parts: string[] = [];
      if (op.start !== undefined) parts.push(`começa em ${formatSeconds(op.start)}`);
      if (op.length !== undefined) parts.push(`dura ${formatSeconds(op.length)}`);
      if (op.trim !== undefined)
        parts.push(`pula os primeiros ${formatSeconds(op.trim)} do arquivo`);
      lines.push(`${label}: ${parts.join(', ')}`);
      if (op.start !== undefined) clip.start = op.start;
      if (op.length !== undefined) clip.length = op.length;
      if (op.trim !== undefined) clip.trim = op.trim;
      return;
    }

    // style
    if (op.text && !isText(clip.type)) {
      problems.push(`${at}: "text" muda só clipes de texto; ${label} não é um.`);
      return;
    }
    if (op.caption && !isCaption(clip.type)) {
      problems.push(`${at}: "caption" muda só legendas; ${label} não é uma.`);
      return;
    }
    if (op.volume !== undefined && !isTimedMedia(clip.type)) {
      problems.push(`${at}: volume é só de vídeo e áudio; ${label} não tem som.`);
      return;
    }
    const parts: string[] = [];
    if (op.position) parts.push(`posição ${POSITION_LABEL[op.position]}`);
    if (op.opacity !== undefined) parts.push(`opacidade ${Math.round(op.opacity * 100)}%`);
    if (op.scale !== undefined) parts.push(`tamanho ${Math.round(op.scale * 100)}%`);
    if (op.volume !== undefined) parts.push(`volume ${Math.round(op.volume * 100)}%`);
    if (op.transitionIn) parts.push(`entrada ${op.transitionIn}`);
    if (op.transitionOut) parts.push(`saída ${op.transitionOut}`);
    if (op.text?.content !== undefined) parts.push(`texto "${op.text.content.slice(0, 40)}"`);
    const font = op.text?.fontFamily ?? op.caption?.fontFamily;
    if (font) parts.push(`fonte ${font}`);
    const size = op.text?.size ?? op.caption?.size;
    if (size !== undefined) parts.push(`letra ${Math.round(size)} px`);
    const color = op.text?.color ?? op.caption?.color;
    if (color) parts.push(`cor ${color}`);
    if (op.caption?.placement) parts.push(PLACEMENT_LABEL[op.caption.placement]);
    if (op.caption?.backgroundColor) parts.push(`fundo ${op.caption.backgroundColor}`);
    if (op.caption?.backgroundOpacity !== undefined)
      parts.push(`fundo a ${Math.round(op.caption.backgroundOpacity * 100)}%`);
    if (parts.length === 0) {
      problems.push(`${at}: nada a mudar em ${label}.`);
      return;
    }
    lines.push(`${label}: ${parts.join(', ')}`);
    if (op.text?.content !== undefined) clip.text = op.text.content;
  });

  return { problems, lines };
}
