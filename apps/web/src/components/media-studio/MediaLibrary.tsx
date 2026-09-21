import {
  MEDIA_ASPECTS,
  MEDIA_MAX_TAGS,
  MEDIA_UPLOAD_TYPES,
  WINGS_CLIENT_ID,
  WINGS_CLIENT_NAME,
  type MediaAsset,
  type MediaEstimate,
  type MediaEstimateRequest,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import { useClients } from '../../api/clients.js';
import {
  PICKED_MEDIA_KEY,
  mediaFileUrl,
  useEstimate,
  useFileMedia,
  useMediaAssets,
  useMediaInBuilder,
  useStartGeneration,
  useUploadMedia,
  type MediaAssetFilters,
} from '../../api/media.js';
import { Button } from '../ui.js';

/**
 * The media library: a grid with filters, and a preview with what can be done
 * to one asset. Everything that spends credits here follows the same two steps
 * as the form: first the cost, then a button that names it.
 */

const credits = (value: number) =>
  `${value.toLocaleString('pt-BR')} ${value === 1 ? 'crédito' : 'créditos'}`;

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('pt-BR')} KB`;

export function MediaThumb({ asset }: { asset: Pick<MediaAsset, 'kind' | 'downloadPath'> }) {
  return asset.kind === 'video' ? (
    <video src={mediaFileUrl(asset)} preload="metadata" muted playsInline aria-hidden="true" />
  ) : (
    <img src={mediaFileUrl(asset)} alt="" loading="lazy" decoding="async" />
  );
}

export function describeAsset(asset: MediaAsset): string {
  const what = asset.kind === 'video' ? 'Vídeo' : 'Imagem';
  const shape = asset.width && asset.height ? `, ${asset.width} × ${asset.height}` : '';
  const from = asset.origin === 'kairogen' ? 'gerado no Kairogen' : 'enviado';
  return `${what}${shape}, ${from} em ${new Date(asset.createdAt).toLocaleDateString('pt-BR')}`;
}

/**
 * "Para quem": Wings Company or one of its clients. Inactive clients are left
 * out, except the one already chosen, so an old asset still shows whose it is.
 */
export function ClientSelect({
  value,
  onChange,
  allLabel,
}: {
  value: string;
  onChange: (clientId: string) => void;
  /** When given, an empty first option with this label (a filter, not a choice). */
  allLabel?: string;
}) {
  const clients = useClients();
  const list = (clients.data?.clients ?? []).filter(
    (client) => client.active || client.id === value,
  );
  return (
    <select className="control" value={value} onChange={(event) => onChange(event.target.value)}>
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      {allLabel === undefined && list.length === 0 && (
        <option value={WINGS_CLIENT_ID}>{WINGS_CLIENT_NAME}</option>
      )}
      {list.map((client) => (
        <option key={client.id} value={client.id}>
          {client.name}
        </option>
      ))}
    </select>
  );
}

/** The filter bar, shared by the library and by the pickers. */
export function MediaFilters({
  value,
  onChange,
  lockKind = false,
}: {
  value: MediaAssetFilters;
  onChange: (next: MediaAssetFilters) => void;
  lockKind?: boolean;
}) {
  const set = (key: keyof MediaAssetFilters, next: string) =>
    onChange({ ...value, [key]: next === '' ? undefined : next });
  return (
    <div className="media-filters" role="search" aria-label="Filtros da biblioteca">
      {!lockKind && (
        <label className="field">
          <span className="field-label">Tipo</span>
          <select
            className="control"
            value={value.kind ?? ''}
            onChange={(e) => set('kind', e.target.value)}
          >
            <option value="">Todos</option>
            <option value="image">Imagens</option>
            <option value="video">Vídeos</option>
          </select>
        </label>
      )}
      <label className="field">
        <span className="field-label">Origem</span>
        <select
          className="control"
          value={value.origin ?? ''}
          onChange={(e) => set('origin', e.target.value)}
        >
          <option value="">Todas</option>
          <option value="kairogen">Geradas no Kairogen</option>
          <option value="upload">Enviadas</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Formato</span>
        <select
          className="control"
          value={value.aspect ?? ''}
          onChange={(e) => set('aspect', e.target.value)}
        >
          <option value="">Todos</option>
          {MEDIA_ASPECTS.map((aspect) => (
            <option key={aspect} value={aspect}>
              {aspect === 'other' ? 'Outro' : aspect}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Cliente</span>
        <ClientSelect
          value={value.clientId ?? ''}
          onChange={(next) => set('clientId', next)}
          allLabel="Todos"
        />
      </label>
      <label className="field">
        <span className="field-label">Tag</span>
        <input
          className="control"
          value={value.tag ?? ''}
          onChange={(e) => set('tag', e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Busca</span>
        <input
          className="control"
          type="search"
          placeholder="Prompt, cliente ou pasta"
          value={value.q ?? ''}
          onChange={(e) => set('q', e.target.value)}
        />
      </label>
    </div>
  );
}

/** An action of the preview that costs credits: estimate first, then a button with the cost. */
function PaidAction({
  label,
  request,
  disabled,
  onStarted,
}: {
  label: string;
  request: MediaEstimateRequest;
  disabled: boolean;
  onStarted: (generationId: string) => void;
}) {
  const estimate = useEstimate();
  const start = useStartGeneration();
  const [quote, setQuote] = useState<MediaEstimate | null>(null);
  const problem = estimate.error ?? start.error;

  return (
    <div className="media-paid-action">
      {quote === null ? (
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || estimate.isPending}
          onClick={() => estimate.mutate(request, { onSuccess: (body) => setQuote(body.estimate) })}
        >
          {label}
        </Button>
      ) : (
        <>
          <Button
            type="button"
            disabled={disabled || start.isPending || quote.blockedBy !== null}
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
            {label} ({credits(quote.credits)})
          </Button>
          <Button type="button" variant="ghost" onClick={() => setQuote(null)}>
            Cancelar
          </Button>
        </>
      )}
      {problem && (
        <p className="field-error" role="alert">
          {problem instanceof ApiError ? problem.message : 'Não foi possível concluir.'}
        </p>
      )}
    </div>
  );
}

function AssetPreview({
  asset,
  canGenerate,
  canUseInBuilder,
  onClose,
  onStarted,
}: {
  asset: MediaAsset;
  canGenerate: boolean;
  canUseInBuilder: boolean;
  onClose: () => void;
  onStarted: (generationId: string) => void;
}) {
  const navigate = useNavigate();
  const bridge = useMediaInBuilder();
  const filing = useFileMedia();
  const [clientId, setClientId] = useState(asset.clientId);
  const [folder, setFolder] = useState(asset.folder ?? '');
  const [tags, setTags] = useState(asset.tags.join(', '));
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="media-dialog-backdrop" onClick={onClose}>
      <div
        className="media-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Prévia da mídia"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="media-dialog-head">
          <h3>{describeAsset(asset)}</h3>
          <button ref={closeButton} type="button" className="link-button" onClick={onClose}>
            Fechar
          </button>
        </div>

        <div className="media-preview">
          {asset.kind === 'video' ? (
            <video src={mediaFileUrl(asset)} controls preload="metadata" />
          ) : (
            <img src={mediaFileUrl(asset)} alt={asset.prompt ?? 'Imagem da biblioteca'} />
          )}
        </div>

        <dl className="agent-card-facts">
          {asset.model && (
            <div>
              <dt>Modelo</dt>
              <dd className="mono">{asset.model}</dd>
            </div>
          )}
          {asset.credits !== null && (
            <div>
              <dt>Custo</dt>
              <dd>{credits(asset.credits)}</dd>
            </div>
          )}
          <div>
            <dt>Arquivo</dt>
            <dd>
              {asset.mimeType.split('/')[1]?.toUpperCase()} · {formatSize(asset.byteSize)}
              {asset.aspect !== 'other' && ` · ${asset.aspect}`}
            </dd>
          </div>
          {asset.client && (
            <div>
              <dt>Para quem</dt>
              <dd>{asset.client}</dd>
            </div>
          )}
          {asset.ownerName && (
            <div>
              <dt>De</dt>
              <dd>{asset.ownerName}</dd>
            </div>
          )}
        </dl>
        {asset.prompt && (
          <details className="agent-details">
            <summary>Prompt</summary>
            <p className="agent-text mono" lang="en">
              {asset.prompt}
            </p>
          </details>
        )}

        {canGenerate && (
          <form
            className="media-filing"
            onSubmit={(event) => {
              event.preventDefault();
              filing.mutate({
                id: asset.id,
                clientId,
                folder: folder.trim() || null,
                tags: tags
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, MEDIA_MAX_TAGS),
              });
            }}
          >
            <label className="field">
              <span className="field-label">Cliente</span>
              <ClientSelect value={clientId} onChange={setClientId} />
            </label>
            <label className="field">
              <span className="field-label">Pasta</span>
              <input
                className="control"
                value={folder}
                maxLength={80}
                onChange={(e) => setFolder(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Tags, separadas por vírgula</span>
              <input className="control" value={tags} onChange={(e) => setTags(e.target.value)} />
            </label>
            <Button type="submit" variant="ghost" disabled={filing.isPending}>
              Salvar organização
            </Button>
            {filing.isSuccess && (
              <span className="field-hint" role="status">
                Salvo.
              </span>
            )}
          </form>
        )}

        <div className="media-actions">
          {canUseInBuilder && (
            <Button
              type="button"
              disabled={bridge.isPending}
              onClick={() =>
                bridge.mutate(asset.id, {
                  onSuccess: (picked) => {
                    try {
                      sessionStorage.setItem(PICKED_MEDIA_KEY, JSON.stringify(picked));
                    } catch {
                      // Without sessionStorage the builder opens empty; nothing is lost.
                    }
                    navigate('/marketing/trafego-pago-wings');
                  },
                })
              }
            >
              Usar no construtor
            </Button>
          )}
          {asset.kind === 'image' && (
            <>
              <PaidAction
                label="Ampliar 2x"
                request={{ operation: 'upscale', assetId: asset.id, scale: 2 }}
                disabled={!canGenerate}
                onStarted={onStarted}
              />
              <PaidAction
                label="Ampliar 4x"
                request={{ operation: 'upscale', assetId: asset.id, scale: 4 }}
                disabled={!canGenerate}
                onStarted={onStarted}
              />
            </>
          )}
          {asset.kind === 'image' && asset.origin === 'kairogen' && (
            <PaidAction
              label="Animar"
              request={{ operation: 'animate', assetId: asset.id }}
              disabled={!canGenerate}
              onStarted={onStarted}
            />
          )}
          <a className="btn btn-ghost" href={mediaFileUrl(asset)} download>
            Baixar
          </a>
        </div>
        {bridge.error && (
          <p className="field-error" role="alert">
            {bridge.error instanceof ApiError
              ? bridge.error.message
              : 'Não foi possível levar a mídia ao construtor.'}
          </p>
        )}
        {asset.kind === 'image' && asset.origin !== 'kairogen' && (
          <p className="field-hint">Animar vale só para imagens geradas no Kairogen.</p>
        )}
      </div>
    </div>
  );
}

export function MediaLibrary({
  canGenerate,
  canUseInBuilder,
  onStarted,
}: {
  canGenerate: boolean;
  canUseInBuilder: boolean;
  onStarted: (generationId: string) => void;
}) {
  const [filters, setFilters] = useState<MediaAssetFilters>({});
  const assets = useMediaAssets(filters);
  const upload = useUploadMedia();
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const list = assets.data?.assets ?? [];
  const open = list.find((asset) => asset.id === openId) ?? null;

  const close = () => {
    setOpenId(null);
    opener.current?.focus();
  };

  return (
    <section className="media-library" aria-labelledby="media-library-title">
      <div className="media-library-head">
        <h2 id="media-library-title">Biblioteca</h2>
        {canGenerate && (
          <label className="btn btn-ghost media-upload">
            Enviar arquivo
            <input
              type="file"
              className="sr-only"
              accept={MEDIA_UPLOAD_TYPES.join(',')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload.mutate(file);
                event.target.value = '';
              }}
            />
          </label>
        )}
      </div>
      {upload.error && (
        <p className="field-error" role="alert">
          {upload.error instanceof ApiError
            ? upload.error.message
            : 'Não foi possível enviar o arquivo.'}
        </p>
      )}

      <MediaFilters value={filters} onChange={setFilters} />

      {assets.isLoading ? (
        <p className="muted" role="status">
          Carregando a biblioteca…
        </p>
      ) : list.length === 0 ? (
        <p className="muted">Nenhuma mídia com esses filtros.</p>
      ) : (
        <ul className="media-grid">
          {list.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                className="media-tile"
                aria-label={describeAsset(asset)}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setOpenId(asset.id);
                }}
              >
                <MediaThumb asset={asset} />
                <span className="media-tile-caption">
                  {asset.kind === 'video'
                    ? 'Vídeo'
                    : asset.aspect === 'other'
                      ? 'Imagem'
                      : asset.aspect}
                  {asset.origin === 'kairogen' && ' · Kairogen'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <AssetPreview
          key={open.id}
          asset={open}
          canGenerate={canGenerate}
          canUseInBuilder={canUseInBuilder}
          onClose={close}
          onStarted={(id) => {
            close();
            onStarted(id);
          }}
        />
      )}
    </section>
  );
}

/**
 * Picks one asset from the library, in a dialog. `refusal` names assets that
 * are shown but cannot be picked, with the reason on the tile.
 */
export function MediaPicker({
  title,
  kind,
  refusal,
  onPick,
  onClose,
}: {
  title: string;
  kind: 'image' | 'video';
  refusal?: (asset: MediaAsset) => string | null;
  onPick: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<MediaAssetFilters>({});
  const assets = useMediaAssets({ ...filters, kind });
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = assets.data?.assets ?? [];
  return (
    <div className="media-dialog-backdrop" onClick={onClose}>
      <div
        className="media-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="media-dialog-head">
          <h3>{title}</h3>
          <button ref={closeButton} type="button" className="link-button" onClick={onClose}>
            Fechar
          </button>
        </div>
        <MediaFilters value={filters} onChange={setFilters} lockKind />
        {assets.isLoading ? (
          <p className="muted" role="status">
            Carregando a biblioteca…
          </p>
        ) : list.length === 0 ? (
          <p className="muted">
            Nenhuma {kind === 'video' ? 'mídia de vídeo' : 'imagem'} na biblioteca com esses
            filtros.
          </p>
        ) : (
          <ul className="media-grid">
            {list.map((asset) => {
              const reason = refusal?.(asset) ?? null;
              return (
                <li key={asset.id}>
                  <button
                    type="button"
                    className="media-tile"
                    aria-label={describeAsset(asset)}
                    disabled={reason !== null}
                    onClick={() => onPick(asset)}
                  >
                    <MediaThumb asset={asset} />
                    <span className="media-tile-caption">
                      {reason ?? (asset.aspect === 'other' ? 'Escolher' : asset.aspect)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
