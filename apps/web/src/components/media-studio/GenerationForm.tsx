import {
  GENERATION_ASPECTS,
  MAX_IMAGES_PER_GENERATION,
  MAX_VIDEOS_PER_GENERATION,
  MEDIA_IMAGE_USES,
  MEDIA_IMAGE_USE_LABEL,
  MEDIA_PROVIDERS,
  MEDIA_PROVIDER_LABEL,
  MEDIA_REFUSAL_MESSAGE,
  MEDIA_UPLOAD_TYPES,
  PROMPT_MAX,
  WINGS_CLIENT_ID,
  formatBrl,
  mediaEstimateRequestSchema,
  modelsForImageUse,
  promptRoomWith,
  withCameraMove,
  type CameraMoveId,
  type GenerationAspect,
  type MediaAlternative,
  type MediaAsset,
  type MediaEstimate,
  type MediaImageUse,
  type MediaModel,
  type MediaProviderId,
  type MediaProviderStatus,
} from '@wings/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  BUILDER_DRAFT_KEY,
  useEstimate,
  useMediaModels,
  useMediaProviders,
  useStartGeneration,
  useUploadMedia,
} from '../../api/media.js';
import { Button } from '../ui.js';
import { CameraMovePicker } from './CameraMovePicker.js';
import { ClientSelect, MediaPicker, MediaThumb } from './MediaLibrary.js';
import { providerHolding } from './ProviderStrip.js';

/**
 * The operator's form. Two steps, always in this order: "Estimar custo" asks
 * the server what it costs, and only then the button reads "Gerar (R$ X)" or
 * "Gerar (N créditos)". Touching any field after an estimate throws the
 * estimate away, so the number on the button is always the number for what is
 * on screen. R$ 0 is a price like any other: it is shown and clicked the same way.
 */

const credits = (value: number) =>
  `${value.toLocaleString('pt-BR')} ${value === 1 ? 'crédito' : 'créditos'}`;

/** What one output costs, as the selector says it. */
function costLabel(model: MediaModel): string {
  if (model.brlCentsPerOutput === 0 && (model.creditsPerOutput ?? 0) === 0) return 'R$ 0 (grátis)';
  if (model.providerId === 'kairogen' && model.creditsPerOutput !== null) {
    return `${credits(model.creditsPerOutput)} por saída`;
  }
  if (model.brlCentsPerOutput !== null) return `≈ ${formatBrl(model.brlCentsPerOutput)} por saída`;
  // The catalog does not always give a price; the estimate always does.
  return 'custo na estimativa';
}

/** The price on the button: credits on Kairogen, reais everywhere else. */
const priceOf = (quote: { credits: number; brlCents: number; providerId: MediaProviderId }) =>
  quote.providerId === 'kairogen' ? credits(quote.credits) : formatBrl(quote.brlCents);

/** The campaign open in the builder, if any, so "same model within a campaign" can be checked. */
function campaignName(): string | undefined {
  try {
    const stored = sessionStorage.getItem(BUILDER_DRAFT_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    const name =
      parsed !== null && typeof parsed === 'object' ? (parsed as { name?: unknown }).name : null;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

type ParamValue = string | boolean;

function defaultsOf(model: MediaModel | undefined): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const param of model?.priceParams ?? []) {
    if (param.type === 'boolean') values[param.key] = param.defaultValue === true;
    // An explicit size overrides the format at Kairogen: left alone, the format decides.
    else if (param.key === 'size') values[param.key] = '';
    else
      values[param.key] =
        typeof param.defaultValue === 'string' ? param.defaultValue : (param.options[0] ?? '');
  }
  return values;
}

/** A picture on the canvas the person wants a variation or an edit of. */
export interface AiTarget {
  mediaAssetId: string;
  use: MediaImageUse;
  name: string;
  /** Changes on every click, so asking twice for the same picture is applied twice. */
  nonce: number;
}

export function GenerationForm({
  canGenerate,
  connected,
  onStarted,
  compact = false,
  defaultClientId,
  aiTarget = null,
}: {
  canGenerate: boolean;
  connected: boolean;
  onStarted: (generationId: string) => void;
  /**
   * The workspace's rail panel: model, prompt, reference and the two buttons
   * in view; format, quantity, duration and the model's parameters behind
   * "Mais opções". The price-before-click flow is the same.
   */
  compact?: boolean;
  /** Where the piece is filed (the workspace's "Para quem"); null means Wings. */
  defaultClientId?: string | null;
  /** Prefills the reference with a picture from the canvas, as a variation or an edit. */
  aiTarget?: AiTarget | null;
}) {
  const [kind, setKind] = useState<'image' | 'video'>('image');
  const models = useMediaModels(kind, connected);
  const providers = useMediaProviders(connected);
  const list = useMemo(() => models.data?.models ?? [], [models.data]);
  const [modelKey, setModelKey] = useState('');
  const model = list.find((item) => item.key === modelKey) ?? list[0];
  /** The selector, grouped by provider in failover order, each group saying what it holds. */
  const groups = useMemo(
    () =>
      MEDIA_PROVIDERS.map((id) => ({
        id,
        status: providers.data?.providers.find((item) => item.id === id),
        models: list.filter((item) => item.providerId === id),
      })).filter((group) => group.models.length > 0),
    [list, providers.data],
  );
  const groupLabel = (id: MediaProviderId, status: MediaProviderStatus | undefined) => {
    const name = MEDIA_PROVIDER_LABEL[id];
    if (!status) return name;
    if (!status.available) return `${name} · ${status.reason ?? 'indisponível'}`;
    const holding = providerHolding(status);
    return holding ? `${name} · ${holding}` : name;
  };
  /** Set by the offer of a costlier model: estimated as soon as the model is on screen. */
  const [pendingEstimate, setPendingEstimate] = useState(false);

  const [clientId, setClientId] = useState<string>(defaultClientId ?? WINGS_CLIENT_ID);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  /** Video only: kept apart from the prompt and added to its end when the cost is asked. */
  const [cameraMove, setCameraMove] = useState<CameraMoveId | null>(null);
  const [aspect, setAspect] = useState<GenerationAspect>('1:1');
  const [quantity, setQuantity] = useState(1);
  const [duration, setDuration] = useState<number | null>(null);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [reference, setReference] = useState<Pick<
    MediaAsset,
    'id' | 'kind' | 'downloadPath'
  > | null>(null);
  const [referenceUse, setReferenceUse] = useState<MediaImageUse>('reference');
  const [picking, setPicking] = useState(false);
  const upload = useUploadMedia();

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
    // A picture chosen for an image stays when the model changes: the form says whether the
    // new model takes it. A video model that takes no first frame has no use for it.
    if (model?.kind === 'video' && !model.acceptsFirstFrame) setReference(null);
    // Keyed on the model alone: the rest is what this effect sets.
  }, [currentKey]);

  const maxQuantity = Math.min(
    model?.maxOutputs ?? MAX_IMAGES_PER_GENERATION,
    kind === 'video' ? MAX_VIDEOS_PER_GENERATION : MAX_IMAGES_PER_GENERATION,
  );
  useEffect(() => {
    if (quantity > maxQuantity) setQuantity(maxQuantity);
  }, [quantity, maxQuantity]);
  // Image: the field is always there. Video: only for a model that starts from a frame.
  const takesReference = kind === 'image' || Boolean(model?.acceptsFirstFrame);
  const referenceLabel = kind === 'video' ? 'Primeiro quadro' : 'Imagem de referência';
  /** The model on screen cannot do what was asked with the picture: say so, offer the ones that can. */
  const mismatch =
    kind === 'image' &&
    reference !== null &&
    model !== undefined &&
    model.imageUse !== referenceUse;
  const able = mismatch ? modelsForImageUse(list, referenceUse).slice(0, 4) : [];
  const readOnly = !canGenerate || !connected;

  // The workspace's "Para quem" follows into the form; the person may still change it here.
  useEffect(() => {
    if (defaultClientId !== undefined) setClientId(defaultClientId ?? WINGS_CLIENT_ID);
  }, [defaultClientId]);

  // A picture chosen on the canvas becomes the reference; the cost is still asked for after.
  useEffect(() => {
    if (!aiTarget) return;
    setKind('image');
    setReference({
      id: aiTarget.mediaAssetId,
      kind: 'image',
      downloadPath: `/media/assets/${aiTarget.mediaAssetId}/file`,
    });
    setReferenceUse(aiTarget.use);
    changed();
    // Keyed on the click, not on the fields it sets.
  }, [aiTarget?.nonce]);

  function askForEstimate() {
    const parsed = mediaEstimateRequestSchema.safeParse({
      operation: 'generate',
      kind,
      model: currentKey,
      prompt: withCameraMove(prompt, kind === 'video' ? cameraMove : null),
      ...(negativePrompt.trim() ? { negativePrompt } : {}),
      aspect,
      quantity,
      ...(kind === 'video' && duration !== null ? { durationSeconds: duration } : {}),
      // A parameter left on "by the format" is not sent: Kairogen's own default applies.
      params: Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '')),
      ...(reference ? { referenceAssetId: reference.id } : {}),
      ...(reference && kind === 'image' ? { referenceUse } : {}),
      clientId,
      ...(campaignName() ? { campaign: campaignName() } : {}),
    });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? 'Confira os campos.');
      return;
    }
    setInvalid(null);
    estimate.mutate(parsed.data, { onSuccess: (body) => setQuote(body.estimate) });
  }

  // The offer of a costlier model was taken: the model is on screen now, so price it.
  useEffect(() => {
    if (!pendingEstimate || model?.key !== modelKey) return;
    setPendingEstimate(false);
    askForEstimate();
    // Only when the offered model has arrived on screen.
  }, [pendingEstimate, modelKey, model?.key]);

  const problem = estimate.error ?? start.error;
  /** A costlier model elsewhere that could do it: switching up is this person's click. */
  const alternative =
    estimate.error instanceof ApiError
      ? ((estimate.error.body as { alternative?: MediaAlternative }).alternative ?? null)
      : null;
  const takeAlternative = (offer: MediaAlternative) => {
    changed();
    setModelKey(offer.model);
    setPendingEstimate(true);
  };

  return (
    <form
      className="media-form"
      aria-labelledby="media-form-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (quote === null) askForEstimate();
      }}
    >
      {!compact && <h2 id="media-form-title">Gerar mídia</h2>}
      {compact && (
        <span id="media-form-title" className="sr-only">
          Gerar mídia
        </span>
      )}
      {!canGenerate && (
        <p className="field-hint">
          Você pode ver a biblioteca, mas não tem permissão para gerar mídia.
        </p>
      )}

      <fieldset className="media-form-fields" disabled={readOnly}>
        {!compact && (
          <>
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
              Serve para arquivar a mídia aqui. O nome do cliente não é enviado a provedor nenhum.
            </span>
          </>
        )}

        <div className="media-form-row">
          <label className="field">
            <span className="field-label">Tipo</span>
            <select
              className="control"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as 'image' | 'video');
                setModelKey('');
                setCameraMove(null);
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
              {groups.map((group) => (
                <optgroup key={group.id} label={groupLabel(group.id, group.status)}>
                  {group.models.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.name} · {costLabel(item)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        {models.data?.problems && Object.keys(models.data.problems).length > 0 && (
          <span className="field-hint" role="status">
            {Object.entries(models.data.problems)
              .map(([id, reason]) => `${MEDIA_PROVIDER_LABEL[id as MediaProviderId]}: ${reason}`)
              .join(' ')}
          </span>
        )}

        <label className="field">
          <span className="field-label">Prompt</span>
          <textarea
            className="control"
            rows={4}
            aria-describedby="media-prompt-hint"
            maxLength={promptRoomWith(kind === 'video' ? cameraMove : null, PROMPT_MAX)}
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

        {kind === 'video' &&
          (compact ? (
            <details className="agent-details">
              <summary>Movimento de câmera{cameraMove ? ' (escolhido)' : ''}</summary>
              <CameraMovePicker
                value={cameraMove}
                onChange={(next) => {
                  setCameraMove(next);
                  changed();
                }}
              />
            </details>
          ) : (
            <CameraMovePicker
              value={cameraMove}
              onChange={(next) => {
                setCameraMove(next);
                changed();
              }}
            />
          ))}

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

        <details className="agent-details media-more" open={!compact}>
          <summary className={compact ? '' : 'sr-only'}>
            {compact ? 'Mais opções' : 'Formato, quantidade e parâmetros'}
          </summary>
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
                    {param.key === 'size' && <option value="">Pelo formato escolhido</option>}
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
        </details>

        {takesReference && (
          <div className="media-reference" role="group" aria-label={referenceLabel}>
            <span className="field-label">{referenceLabel} (opcional)</span>
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
              <div className="media-reference-picked">
                <Button type="button" variant="ghost" onClick={() => setPicking(true)}>
                  Escolher da biblioteca
                </Button>
                {kind === 'image' && !readOnly && (
                  <label className="btn btn-ghost btn-inline media-upload">
                    {upload.isPending ? 'Enviando…' : 'Enviar arquivo'}
                    <input
                      type="file"
                      className="sr-only"
                      accept={MEDIA_UPLOAD_TYPES.filter((type) => type.startsWith('image/')).join(
                        ',',
                      )}
                      disabled={upload.isPending}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        upload.mutate(
                          { file, clientId },
                          {
                            onSuccess: (body) => {
                              setReference(body.asset);
                              changed();
                            },
                          },
                        );
                      }}
                    />
                  </label>
                )}
              </div>
            )}
            {upload.error && (
              <p className="field-error" role="alert">
                {upload.error instanceof ApiError
                  ? upload.error.message
                  : 'Não foi possível enviar o arquivo.'}
              </p>
            )}

            {kind === 'image' && reference && (
              <fieldset className="media-aspects">
                <legend className="field-label">O que fazer com a imagem</legend>
                {MEDIA_IMAGE_USES.map((use) => (
                  <label key={use} className="media-aspect">
                    <input
                      type="radio"
                      name="media-reference-use"
                      value={use}
                      checked={referenceUse === use}
                      onChange={() => {
                        setReferenceUse(use);
                        changed();
                      }}
                    />
                    <span>{MEDIA_IMAGE_USE_LABEL[use]}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {mismatch && model && (
              <div className="alert alert-warning" role="alert">
                <p>
                  {model.name}{' '}
                  {referenceUse === 'edit' ? 'não edita imagens' : 'não usa imagem de referência'}.
                  {model.imageUse === 'edit' && ' Ele só recebe uma imagem para editá-la.'}
                  {model.imageUse === 'reference' &&
                    ' Ele só recebe uma imagem como referência.'}{' '}
                  {able.length > 0
                    ? 'Troque para um modelo que faz isso:'
                    : 'Nenhum modelo do catálogo faz isso.'}
                </p>
                <div className="media-reference-picked">
                  {able.map((item) => (
                    <Button
                      key={item.key}
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setModelKey(item.key);
                        changed();
                      }}
                    >
                      Usar {item.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <span className="field-hint">
              {kind === 'image' && referenceUse === 'edit'
                ? 'No modo edição, o prompt descreve a mudança (por exemplo, "trocar o fundo por cinza claro"). '
                : ''}
              O arquivo enviado entra na biblioteca. O provedor recebe a imagem por um link
              temporário de 15 minutos, ou junto com o pedido quando é assim que ele lê.
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
      {alternative && !readOnly && (
        <div className="media-form-actions">
          <Button type="button" variant="ghost" onClick={() => takeAlternative(alternative)}>
            Usar {alternative.name} ({MEDIA_PROVIDER_LABEL[alternative.providerId]},{' '}
            {alternative.credits
              ? credits(alternative.credits)
              : formatBrl(alternative.brlCents ?? 0)}
            )
          </Button>
        </div>
      )}

      <div className="media-form-actions" aria-live="polite">
        {quote === null ? (
          <Button
            type="submit"
            disabled={readOnly || estimate.isPending || currentKey === '' || mismatch}
          >
            {estimate.isPending ? 'Estimando…' : 'Estimar custo'}
          </Button>
        ) : (
          <>
            <span className="media-cost">
              Custo: {priceOf(quote)} · {MEDIA_PROVIDER_LABEL[quote.providerId]}
            </span>
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
              Gerar ({priceOf(quote)})
            </Button>
          </>
        )}
      </div>
      {quote?.blockedBy && (
        <div className="alert alert-warning" role="status">
          {MEDIA_REFUSAL_MESSAGE[quote.blockedBy]}
        </div>
      )}
      {quote && quote.warnings.length > 0 && (
        <div className="alert alert-warning" role="status">
          <ul className="media-warnings">
            {quote.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
