import type { MediaModel, MediaPriceParam } from '@wings/shared';
import type { McpToolResult } from '../../lib/mcp-client/index.js';

/**
 * Where Kairogen's answers are read.
 *
 * The ARGUMENTS of its tools are known from `tools/list`
 * (docs/integracoes/kairogen-tools.json). The shape of its ANSWERS is not
 * published, so every reader here is tolerant: it looks for the fields the tool
 * descriptions name (`credit_cost`, `generation_id`, `output_url`,
 * `param_schema`, `supported_durations`, `modelKey`) under the spellings an API
 * of this kind uses, and says "I could not tell" rather than guess. The first
 * real generation (2026-09-21) went through every reader here but the price per
 * model, which came back null; it left no record of the field names, which is
 * what `shapeOf` is for. When the shapes are in the log, this file is the only
 * one that changes.
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

/** Keys whose short, word-like values say how to read the rest (a status, a type). */
const WORD_KEYS = ['status', 'state', 'type', 'kind', 'plan', 'plankey', 'unit', 'currency'];

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
  if (depth >= 6) return '…';
  if (Array.isArray(value)) {
    return {
      arrayOf: value.length,
      first: value.slice(0, 2).map((item) => shapeOf(item, key, depth + 1)),
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

function schemaProperties(model: Json): Json {
  const schema = pick(model, 'param_schema', 'paramSchema', 'parameters', 'params');
  const properties = pick(schema, 'properties');
  return isObject(properties) ? properties : isObject(schema) ? schema : {};
}

function priceParamsOf(properties: Json): MediaPriceParam[] {
  return Object.entries(properties).flatMap(([key, raw]): MediaPriceParam[] => {
    const name = PRICE_KEYS.find((candidate) => fold(candidate) === fold(key));
    if (!name || !isObject(raw)) return [];
    const options = pick(raw, 'enum', 'options', 'values');
    const defaultValue = pick(raw, 'default');
    if (Array.isArray(options) && options.length > 0) {
      return [
        {
          key: name,
          label: PRICE_LABEL[name] ?? name,
          type: 'choice',
          options: options.map(String),
          defaultValue: defaultValue === undefined ? null : String(defaultValue),
        },
      ];
    }
    if (pick(raw, 'type') === 'boolean') {
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

/** Credits for one output on the given plan, from whichever pricing shape the catalog uses. */
function creditsPerOutput(model: Json, plan: string): number | null {
  const pricing = pick(model, 'pricing', 'price', 'prices', 'credits', 'credit_cost', 'cost');
  const flat = asNumber(pricing);
  if (flat !== null) return flat;
  if (!isObject(pricing)) return null;
  const byPlan = pick(pricing, plan) ?? pick(pick(pricing, 'plans', 'by_plan', 'byPlan'), plan);
  return (
    asNumber(byPlan) ??
    asNumber(pick(byPlan, 'credits', 'credit_cost', 'per_output', 'perOutput', 'base')) ??
    asNumber(pick(pricing, 'credits', 'credit_cost', 'per_output', 'perOutput', 'base', 'default'))
  );
}

export function modelsFrom(result: McpToolResult, plan: string): MediaModel[] {
  return listOf(result.data, 'models', 'items', 'data', 'results').flatMap(
    (model): MediaModel[] => {
      const key = asText(pick(model, 'modelKey', 'model_key', 'key', 'id', 'slug'));
      const type = asText(pick(model, 'type', 'kind', 'category', 'media_type'))?.toLowerCase();
      if (!key || (type !== 'image' && type !== 'video')) return [];
      const properties = schemaProperties(model);
      const has = (...names: string[]) =>
        Object.keys(properties).some((name) => names.map(fold).includes(fold(name)));
      const durations = pick(model, 'supported_durations', 'supportedDurations', 'durations');
      const durationEnum = pick(pick(properties, 'duration_seconds', 'duration'), 'enum');
      const ratios = pick(model, 'aspect_ratios', 'aspectRatios', 'supported_aspect_ratios');
      const ratioEnum = pick(pick(properties, 'aspect_ratio', 'aspectRatio'), 'enum');
      const ratioList = Array.isArray(ratios)
        ? ratios
        : Array.isArray(ratioEnum)
          ? ratioEnum
          : null;

      return [
        {
          key,
          name: asText(pick(model, 'name', 'display_name', 'displayName', 'title')) ?? key,
          provider: asText(pick(model, 'providerName', 'provider_name', 'provider')),
          kind: type,
          creditsPerOutput: creditsPerOutput(model, plan),
          supportedDurations: (Array.isArray(durations)
            ? durations
            : Array.isArray(durationEnum)
              ? durationEnum
              : []
          )
            .map(asNumber)
            .filter((value): value is number => value !== null),
          aspectRatios: ratioList ? ratioList.map(String) : null,
          priceParams: priceParamsOf(properties),
          acceptsReferenceImage: has('reference_image_urls', 'reference_images', 'image_urls'),
          acceptsFirstFrame:
            has('first_frame_url', 'first_frame', 'image', 'image_url', 'start_image') ||
            /image-to-video|i2v/i.test(key),
        },
      ];
    },
  );
}

// ---------------------------------------------------------------------------
// estimate_cost, generate_*, get_generation
// ---------------------------------------------------------------------------

/** The quote, or null when the answer carries no number under a credit-like name. */
export function creditCostFrom(result: McpToolResult): number | null {
  const direct = asNumber(result.data);
  if (direct !== null) return Math.ceil(direct);
  const found =
    asNumber(pick(result.data, 'credit_cost', 'creditCost', 'credits', 'cost', 'total_credits')) ??
    asNumber(
      pick(
        pick(result.data, 'estimate', 'quote', 'pricing', 'data'),
        'credit_cost',
        'creditCost',
        'credits',
        'cost',
        'total_credits',
      ),
    );
  return found === null ? null : Math.ceil(found);
}

export function generationIdFrom(result: McpToolResult): string | null {
  const direct =
    pick(result.data, 'generation_id', 'generationId', 'id') ??
    pick(pick(result.data, 'generation', 'data', 'job'), 'generation_id', 'generationId', 'id');
  const text = asText(direct) ?? (typeof direct === 'number' ? String(direct) : null);
  if (text) return text.slice(0, 200);
  return /generation[_ ]?id["':\s]+([A-Za-z0-9_-]{6,})/i.exec(result.text)?.[1] ?? null;
}

const DONE = ['completed', 'complete', 'succeeded', 'success', 'done', 'ready', 'finished'];
const FAILED = ['failed', 'error', 'errored', 'canceled', 'cancelled', 'rejected', 'expired'];

export interface GenerationState {
  state: 'running' | 'succeeded' | 'failed';
  outputUrls: string[];
  creditsCharged: number | null;
  /** Kairogen's own status word, for the record. Never shown as an instruction. */
  providerStatus: string | null;
}

function urlsIn(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return /^https:\/\/\S+$/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => urlsIn(item, depth + 1));
  if (!isObject(value)) return [];
  const own = pick(value, 'output_url', 'outputUrl', 'url', 'file_url', 'fileUrl', 'download_url');
  return typeof own === 'string' ? urlsIn(own) : [];
}

export function generationStateFrom(result: McpToolResult): GenerationState {
  const root = isObject(pick(result.data, 'generation', 'data', 'job'))
    ? (pick(result.data, 'generation', 'data', 'job') as Json)
    : result.data;
  const providerStatus = asText(pick(root, 'status', 'state'))?.toLowerCase() ?? null;
  const outputs = pick(root, 'output_urls', 'outputUrls', 'outputs', 'results', 'files', 'assets');
  const single = pick(root, 'output_url', 'outputUrl');
  // Only addresses under an output-like name: a thumbnail or a docs link is not the result.
  const outputUrls = [...new Set([...urlsIn(outputs), ...urlsIn(single)])];
  const creditsCharged = asNumber(
    pick(
      root,
      'credits_charged',
      'creditsCharged',
      'credit_cost',
      'creditCost',
      'credits_used',
      'cost',
    ),
  );

  const failed = providerStatus !== null && FAILED.includes(providerStatus);
  const done = providerStatus !== null ? DONE.includes(providerStatus) : outputUrls.length > 0;
  return {
    state: failed ? 'failed' : done && outputUrls.length > 0 ? 'succeeded' : 'running',
    outputUrls,
    creditsCharged: creditsCharged === null ? null : Math.ceil(creditsCharged),
    providerStatus,
  };
}

/** True when Kairogen said no because the charge would differ from `expected_credits`. */
export function isCreditMismatch(message: string): boolean {
  return /expected[_ ]credits|credit[_ ]?cost|differ|mismatch|diverg/i.test(message);
}
