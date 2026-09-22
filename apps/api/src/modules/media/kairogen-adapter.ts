import type { MediaModel, MediaPriceParam } from '@wings/shared';
import type { McpToolResult } from '../../lib/mcp-client/index.js';

/**
 * Where Kairogen's answers are read.
 *
 * The ARGUMENTS of its tools come from `tools/list`
 * (docs/integracoes/kairogen-tools.json). The shape of its ANSWERS is not
 * published; it was read from the `kairogen answer shape` lines the staging API
 * logged on 2026-09-21 (docs/integracoes/kairogen.md, "O formato real das
 * respostas"). The readers below use those names and nothing else. Where the
 * log could not show something (the option list of a select parameter, the
 * status word of a failure), the reader says so and stays tolerant there only.
 *
 * Everything that arrives here is a third party's DATA. The tool descriptions
 * carry advice written for chat widgets ("never give up", "retry", "open the
 * widget"); none of it is an instruction to this system.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Case- and separator-blind: `modelKey`, `model_key` and `ModelKey` are one name. */
const fold = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(source: unknown, ...names: string[]): unknown {
  if (!isObject(source)) return undefined;
  const wanted = names.map(fold);
  for (const [key, value] of Object.entries(source)) {
    if (wanted.includes(fold(key)) && value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** The first array of objects found under any of the names, or the value itself if it is one. */
function listOf(data: unknown, ...names: string[]): Json[] {
  const direct = Array.isArray(data) ? data : pick(data, ...names);
  return Array.isArray(direct) ? direct.filter(isObject) : [];
}

const asNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};
const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

// ---------------------------------------------------------------------------
// The shape of an answer, without its contents
// ---------------------------------------------------------------------------

/**
 * Keys whose short, word-like values are vocabulary, not content: a status, a
 * type, the name of a parameter or of a mode. Without them a schema cannot be read.
 */
const WORD_KEYS = [
  'status',
  'state',
  'type',
  'kind',
  'plan',
  'plankey',
  'unit',
  'currency',
  'key',
  'paramkey',
  'role',
  'media',
  'mediatype',
  'tag',
  'modes',
  'defaultmode',
  'requiredinputs',
  'referencefieldkeys',
  'controltype',
  'pollwith',
];
/** Lists that ARE the schema: two items of them say too little. */
const LONG_LISTS = ['paramschema', 'conditionalpricing', 'referenceinputs', 'options'];

/**
 * An answer reduced to what a reader needs to know about it: the key names, the
 * types, the numbers. Every string is replaced by its length (an address by its
 * host), so no prompt, link, name or token can ride along into a log. This is
 * how the real format gets known without anybody copying a response by hand.
 */
export function shapeOf(value: unknown, key = '', depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (WORD_KEYS.includes(fold(key)) && /^[A-Za-z0-9_.-]{1,40}$/.test(value)) return value;
    try {
      if (/^https?:\/\//i.test(value)) return `url(${new URL(value).host})`;
    } catch {
      // Not an address after all.
    }
    return `string(${value.length})`;
  }
  if (depth >= 8) return '…';
  if (Array.isArray(value)) {
    const shown = LONG_LISTS.includes(fold(key)) ? 8 : 2;
    return {
      arrayOf: value.length,
      first: value.slice(0, shown).map((item) => shapeOf(item, key, depth + 1)),
    };
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([name, inner]) => [name.slice(0, 60), shapeOf(inner, name, depth + 1)]),
    );
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// list_models
// ---------------------------------------------------------------------------

/** Parameters that move the price, by the names `estimate_cost` takes them under. */
const PRICE_KEYS = ['size', 'quality', 'resolution', 'turbo', 'generate_audio', 'sound'];
const PRICE_LABEL: Record<string, string> = {
  size: 'Tamanho',
  quality: 'Qualidade',
  resolution: 'Resolução',
  turbo: 'Modo turbo',
  generate_audio: 'Gerar áudio',
  sound: 'Som',
};

/** `param_schema` is a LIST of fields, each `{ key, type, label, required, default, … }`. */
const fieldsOf = (model: Json): Json[] => listOf(pick(model, 'param_schema'));

/**
 * The choices of a select field. NOT verified: the two fields the log showed
 * were a number and a file, so the list is looked for under the usual names and
 * taken as plain values or as `{ value }` objects.
 */
function optionsOf(field: Json): string[] {
  const options = pick(field, 'options', 'enum', 'values');
  if (!Array.isArray(options)) return [];
  return options.flatMap((option): string[] => {
    const value = isObject(option) ? pick(option, 'value', 'key', 'id') : option;
    return typeof value === 'string' || typeof value === 'number' ? [String(value)] : [];
  });
}

const RATIO = /^\d+:\d+$/;

function priceParamsOf(fields: Json[]): MediaPriceParam[] {
  return fields.flatMap((field): MediaPriceParam[] => {
    const key = asText(pick(field, 'key'));
    const name = PRICE_KEYS.find((candidate) => key !== null && fold(candidate) === fold(key));
    if (!name) return [];
    const options = optionsOf(field);
    const defaultValue = pick(field, 'default');
    // A `size` made of ratios ("1:1") is the shape of the picture, not a price tier.
    if (options.length > 0 && !options.every((option) => RATIO.test(option))) {
      return [
        {
          key: name,
          label: PRICE_LABEL[name] ?? name,
          type: 'choice',
          options,
          defaultValue: defaultValue === undefined ? null : String(defaultValue),
        },
      ];
    }
    if (pick(field, 'type') === 'boolean') {
      return [
        {
          key: name,
          label: PRICE_LABEL[name] ?? name,
          type: 'boolean',
          options: [],
          defaultValue: typeof defaultValue === 'boolean' ? defaultValue : false,
        },
      ];
    }
    return [];
  });
}

/** The shapes a model draws, when a field lists them as ratios (`aspect_ratio`, or a ratio `size`). */
function aspectRatiosOf(fields: Json[]): string[] | null {
  for (const field of fields) {
    const key = fold(asText(pick(field, 'key')) ?? '');
    if (key !== 'aspectratio' && key !== 'size') continue;
    const ratios = optionsOf(field).filter((option) => RATIO.test(option));
    if (ratios.length > 0) return ratios;
  }
  return null;
}

/**
 * What a model does with a picture it is handed, from `reference_inputs`
 * (`{ param_key, role, media, max_files, required, modes }`) and `modes`
 * (`{ base, edit, … }`, each with `auto_switch_on_reference`).
 *
 *  - an input open in every mode (`modes: null`), or in the default one: the
 *    picture is a REFERENCE for a new one;
 *  - an input that exists only in the `edit` mode: handing the picture over IS
 *    editing it (`auto_switch_on_reference`), as with GPT Image;
 *  - no image input: the model takes no picture at all.
 */
function imageUseOf(model: Json): MediaModel['imageUse'] {
  const inputs = listOf(pick(model, 'reference_inputs')).filter((input) => {
    const media = asText(pick(input, 'media'))?.toLowerCase();
    return media === undefined || media === null || media === 'image';
  });
  if (inputs.length === 0) return null;
  const modes = pick(model, 'modes');
  const hasEdit = isObject(modes) && isObject(pick(modes, 'edit'));
  const defaultMode = asText(pick(model, 'default_mode'))?.toLowerCase() ?? null;
  const openByDefault = inputs.some((input) => {
    const only = pick(input, 'modes');
    if (!Array.isArray(only) || only.length === 0) return true;
    return (
      defaultMode !== null && only.map((mode) => String(mode).toLowerCase()).includes(defaultMode)
    );
  });
  return openByDefault ? 'reference' : hasEdit ? 'edit' : 'reference';
}

export function modelsFrom(result: McpToolResult): MediaModel[] {
  return listOf(result.data, 'models').flatMap((model): MediaModel[] => {
    const key = asText(pick(model, 'model_key'));
    const type = asText(pick(model, 'type'))?.toLowerCase();
    if (!key || (type !== 'image' && type !== 'video')) return [];
    const fields = fieldsOf(model);
    const durations = pick(model, 'supported_durations');
    const inputs = listOf(pick(model, 'reference_inputs'));
    const imageUse = imageUseOf(model);

    return [
      {
        key,
        name: asText(pick(model, 'name')) ?? key,
        providerId: 'kairogen',
        provider: asText(pick(model, 'provider')),
        kind: type,
        // The catalog prices in money (`pricing.baseCost`, BRL, plus a markup and
        // `conditionalPricing`), never in credits. Credits come from `estimate_cost`
        // alone; the Kairogen provider asks it once per model and fills both in.
        creditsPerOutput: null,
        brlCentsPerOutput: null,
        maxOutputs: type === 'video' ? 2 : 4,
        supportedDurations: (Array.isArray(durations) ? durations : [])
          .map(asNumber)
          .filter((value): value is number => value !== null),
        aspectRatios: aspectRatiosOf(fields),
        priceParams: priceParamsOf(fields),
        imageUse: type === 'image' ? imageUse : null,
        acceptsReferenceImage: type === 'image' && imageUse !== null,
        // Video: an image input the model cannot do without is its first frame.
        acceptsFirstFrame:
          type === 'video' &&
          inputs.some(
            (input) =>
              pick(input, 'required') === true || /frame/i.test(asText(pick(input, 'role')) ?? ''),
          ),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// estimate_cost, generate_*, get_generation
// ---------------------------------------------------------------------------

/** `estimate_cost` answers `{ model_key, credit_cost, quantity, plan_key, params, … }`. */
export function creditCostFrom(result: McpToolResult): number | null {
  const found = asNumber(pick(result.data, 'credit_cost'));
  return found === null || found < 0 ? null : Math.ceil(found);
}

/** `generate_*` answers `{ generation_id, generation_ids, status: 'QUEUED', pending: true, … }`. */
export function generationIdFrom(result: McpToolResult): string | null {
  const direct = pick(result.data, 'generation_id');
  const first = pick(result.data, 'generation_ids');
  const text = asText(direct) ?? (Array.isArray(first) ? asText(first[0]) : null);
  return text ? text.slice(0, 200) : null;
}

/** Seen: QUEUED, PROCESSING, COMPLETED. A failure was never seen, so its word is a guess. */
const DONE = ['completed'];
const FAILED = ['failed', 'error', 'errored', 'canceled', 'cancelled', 'rejected', 'expired'];

export interface GenerationState {
  state: 'running' | 'succeeded' | 'failed';
  outputUrls: string[];
  creditsCharged: number | null;
  /** Kairogen's own status word, for the record. Never shown as an instruction. */
  providerStatus: string | null;
  /** `reference_warning`: what Kairogen says it did with the picture it was handed. Data. */
  referenceWarning: string | null;
}

/**
 * `get_generation` answers `{ generation_id, status, output_urls: string[],
 * cost_credits, pending, reference_warning?, … }`.
 */
export function generationStateFrom(result: McpToolResult): GenerationState {
  const providerStatus = asText(pick(result.data, 'status'))?.toLowerCase() ?? null;
  const outputs = pick(result.data, 'output_urls');
  const outputUrls = [
    ...new Set(
      (Array.isArray(outputs) ? outputs : []).filter(
        (url): url is string => typeof url === 'string' && /^https:\/\/\S+$/i.test(url),
      ),
    ),
  ];
  const creditsCharged = asNumber(pick(result.data, 'cost_credits'));
  const pending = pick(result.data, 'pending');

  const done = providerStatus !== null && DONE.includes(providerStatus) && outputUrls.length > 0;
  // Over (`pending: false`) with nothing to show: whatever word it uses, it failed.
  const failed =
    !done && ((providerStatus !== null && FAILED.includes(providerStatus)) || pending === false);
  return {
    state: failed ? 'failed' : done ? 'succeeded' : 'running',
    outputUrls,
    creditsCharged: creditsCharged === null ? null : Math.ceil(creditsCharged),
    providerStatus,
    referenceWarning: asText(pick(result.data, 'reference_warning')),
  };
}

/** True when Kairogen said no because the charge would differ from `expected_credits`. */
export function isCreditMismatch(message: string): boolean {
  return /expected[_ ]credits|credit[_ ]?cost|differ|mismatch|diverg/i.test(message);
}
