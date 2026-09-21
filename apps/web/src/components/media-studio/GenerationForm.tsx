import {
  GENERATION_ASPECTS,
  MAX_IMAGES_PER_GENERATION,
  MAX_VIDEOS_PER_GENERATION,
  MEDIA_REFUSAL_MESSAGE,
  PROMPT_MAX,
  WINGS_CLIENT_ID,
  mediaEstimateRequestSchema,
  type GenerationAspect,
  type MediaAsset,
  type MediaEstimate,
  type MediaModel,
} from '@wings/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useEstimate, useMediaModels, useStartGeneration } from '../../api/media.js';
import { Button } from '../ui.js';
import { ClientSelect, MediaPicker, MediaThumb } from './MediaLibrary.js';

/**
 * The operator's form. Two steps, always in this order: "Estimar custo" asks
 * the server what it costs, and only then the button reads "Gerar (N créditos)".
 * Touching any field after an estimate throws the estimate away, so the number
 * on the button is always the number for what is on screen.
 */

const credits = (value: number) =>
  `${value.toLocaleString('pt-BR')} ${value === 1 ? 'crédito' : 'créditos'}`;

type ParamValue = string | boolean;

function defaultsOf(model: MediaModel | undefined): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of model?.priceParams ?? []) {
    if (param.type === 'boolean') values[param.key] = param.defaultValue === true;
    else
      values[param.key] =
        typeof param.defaultValue === 'string' ? param.defaultValue : (param.options[0] ?? '');
  }
  return values;
}

export function GenerationForm({
  canGenerate,
  connected,
  onStarted,
}: {
  canGenerate: boolean;
  connected: boolean;
  onStarted: (generationId: string) => void;
}) {
  const [kind, setKind] = useState<'image' | 'video'>('image');
  const models = useMediaModels(kind, connected);
  const list = useMemo(() => models.data?.models ?? [], [models.data]);
  const [modelKey, setModelKey] = useState('');
  const model = list.find((item) => item.key === modelKey) ?? list[0];

  const [clientId, setClientId] = useState<string>(WINGS_CLIENT_ID);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspect, setAspect] = useState<GenerationAspect>('1:1');
  const [quantity, setQuantity] = useState(1);
  const [duration, setDuration] = useState<number | null>(null);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [reference, setReference] = useState<MediaAsset | null>(null);
  const [picking, setPicking] = useState(false);

  const estimate = useEstimate();
  const start = useStartGeneration();
  const [quote, setQuote] = useState<MediaEstimate | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);

  /** Any change to what would be generated makes the estimate on screen a lie: drop it. */
  const changed = () => {
    setQuote(null);
    setInvalid(null);
    estimate.reset();
    start.reset();
  };

  // A new model brings its own parameters, durations and shapes.
  const currentKey = model?.key ?? '';
  useEffect(() => {
    setParams(defaultsOf(model));
    setDuration(
      model && model.supportedDurations.length > 0 ? (model.supportedDurations[0] ?? null) : null,
    );
    if (model?.aspectRatios && !model.aspectRatios.includes(aspect)) {
      const first = GENERATION_ASPECTS.find((item) => model.aspectRatios?.includes(item));
      if (first) setAspect(first);
    }
    if (!model?.acceptsReferenceImage && !model?.acceptsFirstFrame) setReference(null);
    // Keyed on the model alone: the rest is what this effect sets.
  }, [currentKey]);

  const maxQuantity = kind === 'video' ? MAX_VIDEOS_PER_GENERATION : MAX_IMAGES_PER_GENERATION;
  const takesReference = Boolean(model?.acceptsReferenceImage || model?.acceptsFirstFrame);
  const referenceLabel =
    kind === 'video' && model?.acceptsFirstFrame ? 'Primeiro quadro' : 'Imagem de referência';
  const readOnly = !canGenerate || !connected;

  function askForEstimate() {
    const parsed = mediaEstimateRequestSchema.safeParse({
      operation: 'generate',
      kind,
      model: currentKey,
      prompt,
      ...(negativePrompt.trim() ? { negativePrompt } : {}),
      aspect,
      quantity,
      ...(kind === 'video' && duration !== null ? { durationSeconds: duration } : {}),
      params,
      ...(reference ? { referenceAssetId: reference.id } : {}),
      clientId,
    });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Confira os campos.');
      return;
    }
    setInvalid(null);
    estimate.mutate(parsed.data, { onSuccess: (body) => setQuote(body.estimate) });
  }

  const problem = estimate.error ?? start.error;

  return (
    <form
      className="media-form"
      aria-labelledby="media-form-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (quote === null) askForEstimate();
      }}
    >
      <h2 id="media-form-title">Gerar mídia</h2>
      {!canGenerate && (
        <p className="field-hint">
          Você pode ver a biblioteca, mas não tem permissão para gerar mídia.
        </p>
      )}

      <fieldset className="media-form-fields" disabled={readOnly}>
        <label className="field">
          <span className="field-label">Para quem</span>
          <ClientSelect
            value={clientId}
            onChange={(next) => {
              setClientId(next);
              changed();
            }}
          />
        </label>
        <span className="field-hint">
          Serve para arquivar a mídia aqui. O nome do cliente não é enviado ao Kairogen.
        </span>

        <div className="media-form-row">
          <label className="field">
            <span className="field-label">Tipo</span>
            <select
              className="control"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as 'image' | 'video');
                setModelKey('');
                setQuantity(1);
                changed();
              }}
            >
              <option value="image">Imagem</option>
              <option value="video">Vídeo</option>
            </select>
          </label>
          <label className="field media-form-model">
            <span className="field-label">Modelo</span>
            <select
              className="control"
              value={currentKey}
              onChange={(event) => {
                setModelKey(event.target.value);
                changed();
              }}
            >
              {list.length === 0 && (
                <option value="">{models.isLoading ? 'Carregando…' : 'Nenhum modelo'}</option>
              )}
              {list.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                  {/* The catalog does not always give a price; the estimate always does. */}
                  {item.creditsPerOutput !== null
                    ? ` · ${credits(item.creditsPerOutput)} por saída`
                    : ' · custo na estimativa'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Prompt</span>
          <textarea
            className="control"
            rows={4}
            aria-describedby="media-prompt-hint"
            maxLength={PROMPT_MAX}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              changed();
            }}
          />
        </label>
        <span id="media-prompt-hint" className="field-hint">
          Descreva cena, luz, enquadramento e estilo. Em inglês os modelos costumam responder
          melhor.
        </span>

        <details className="agent-details">
          <summary>Prompt negativo (opcional)</summary>
          <label className="field">
            <span className="field-label">O que evitar</span>
            <textarea
              className="control"
              rows={2}
              maxLength={600}
              value={negativePrompt}
              onChange={(event) => {
                setNegativePrompt(event.target.value);
                changed();
              }}
            />
          </label>
        </details>

        <div className="media-form-row">
          <fieldset className="media-aspects">
            <legend className="field-label">Formato</legend>
            {GENERATION_ASPECTS.map((item) => {
              const refused = model?.aspectRatios != null && !model.aspectRatios.includes(item);
              return (
                <label key={item} className="media-aspect">
                  <input
                    type="radio"
                    name="media-aspect"
                    value={item}
                    checked={aspect === item}
                    disabled={refused}
                    onChange={() => {
                      setAspect(item);
                      changed();
                    }}
                  />
                  <span>{item}</span>
                </label>
              );
            })}
          </fieldset>

          <label className="field">
            <span className="field-label">Quantidade</span>
            <select
              className="control"
              value={quantity}
              onChange={(event) => {
                setQuantity(Number(event.target.value));
                changed();
              }}
            >
              {Array.from({ length: maxQuantity }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          {kind === 'video' && model && model.supportedDurations.length > 0 && (
            <label className="field">
              <span className="field-label">Duração</span>
              <select
                className="control"
                value={duration ?? ''}
                onChange={(event) => {
                  setDuration(Number(event.target.value));
                  changed();
                }}
              >
                {model.supportedDurations.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds} s
                  </option>
                ))}
              </select>
            </label>
          )}

          {(model?.priceParams ?? []).map((param) =>
            param.type === 'boolean' ? (
              <label key={param.key} className="media-check">
                <input
                  type="checkbox"
                  checked={params[param.key] === true}
                  onChange={(event) => {
                    setParams((current) => ({ ...current, [param.key]: event.target.checked }));
                    changed();
                  }}
                />
                <span>{param.label}</span>
              </label>
            ) : (
              <label key={param.key} className="field">
                <span className="field-label">{param.label}</span>
                <select
                  className="control"
                  value={String(params[param.key] ?? '')}
                  onChange={(event) => {
                    setParams((current) => ({ ...current, [param.key]: event.target.value }));
                    changed();
                  }}
                >
                  {param.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            ),
          )}
        </div>

        {takesReference && (
          <div className="media-reference">
            <span className="field-label">{referenceLabel}</span>
            {reference ? (
              <div className="media-reference-picked">
                <MediaThumb asset={reference} />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setReference(null);
                    changed();
                  }}
                >
                  Tirar
                </Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setPicking(true)}>
                Escolher da biblioteca
              </Button>
            )}
            <span className="field-hint">
              O Kairogen recebe um link temporário desta imagem, válido por 15 minutos.
            </span>
          </div>
        )}
      </fieldset>

      {invalid && (
        <p className="field-error" role="alert">
          {invalid}
        </p>
      )}
      {problem && (
        <p className="field-error" role="alert">
          {problem instanceof ApiError ? problem.message : 'Não foi possível concluir.'}
        </p>
      )}

      <div className="media-form-actions" aria-live="polite">
        {quote === null ? (
          <Button type="submit" disabled={readOnly || estimate.isPending || currentKey === ''}>
            {estimate.isPending ? 'Estimando…' : 'Estimar custo'}
          </Button>
        ) : (
          <>
            <span className="media-cost">Custo: {credits(quote.credits)}</span>
            <Button
              type="button"
              disabled={readOnly || start.isPending || quote.blockedBy !== null}
              onClick={() =>
                start.mutate(
                  { estimateId: quote.id },
                  {
                    onSuccess: (body) => {
                      setQuote(null);
                      onStarted(body.generation.id);
                    },
                  },
                )
              }
            >
              Gerar ({credits(quote.credits)})
            </Button>
          </>
        )}
      </div>
      {quote?.blockedBy && (
        <div className="alert alert-warning" role="status">
          {MEDIA_REFUSAL_MESSAGE[quote.blockedBy]}
        </div>
      )}

      {picking && (
        <MediaPicker
          title={referenceLabel}
          kind="image"
          onClose={() => setPicking(false)}
          onPick={(asset) => {
            setReference(asset);
            setPicking(false);
            changed();
          }}
        />
      )}
    </form>
  );
}
