import {
  BRAND_ARTICLES,
  BRAND_ARTICLE_LABELS,
  WA_ART_HEIGHT,
  WA_ART_WIDTH,
  type BrandArticle,
} from '@wings/shared';
import { useRef } from 'react';
import { ApiError } from '../api/client.js';
import {
  useClientWhatsApp,
  useRemoveClientArt,
  useSetClientArticle,
  useUploadClientArt,
} from '../api/clients.js';
import { Alert, Button, Field, Select } from './ui.js';

/**
 * The WhatsApp header of a brand (its art and the article before its name),
 * or the Wings art of the Formatação templates (`wings`). The image comes
 * through an address of 5 minutes; the server checks the file again.
 */

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

export function WhatsAppArtPanel({
  clientId,
  name,
  canEdit,
  wings = false,
}: {
  clientId: string;
  name: string;
  canEdit: boolean;
  /** The Wings art (Wings Company's record): no article. */
  wings?: boolean;
}) {
  const state = useClientWhatsApp(clientId);
  const upload = useUploadClientArt(clientId);
  const remove = useRemoveClientArt(clientId);
  const article = useSetClientArticle(clientId);
  const input = useRef<HTMLInputElement>(null);
  const art = state.data?.art ?? null;
  const busy = upload.isPending || remove.isPending;

  return (
    <section
      className="wa-art-panel"
      aria-label={wings ? 'Arte do WhatsApp da Wings' : 'WhatsApp da marca'}
    >
      <div className="wa-art-head">
        <h3 className="record-subhead">
          {wings ? 'Arte do WhatsApp da Wings (modelos da Formatação)' : 'WhatsApp da marca'}
        </h3>
        <p className="muted">
          {wings
            ? 'Vai no cabeçalho dos modelos da Formatação e das mensagens da Wings.'
            : `Vai no cabeçalho dos modelos de Expansão de ${name}. O lead nunca vê a Wings.`}{' '}
          PNG ou JPEG, {WA_ART_WIDTH} × {WA_ART_HEIGHT} pixels, até 2 MB.
        </p>
      </div>

      {state.isLoading ? (
        <p className="muted">Carregando…</p>
      ) : art ? (
        <img
          className="wa-art-image"
          src={art.url}
          alt={wings ? 'Arte do WhatsApp da Wings' : `Arte do WhatsApp de ${name}`}
          width={WA_ART_WIDTH}
          height={WA_ART_HEIGHT}
        />
      ) : (
        <Alert kind="warning">
          {wings
            ? 'Cadastre a arte do WhatsApp da Wings: sem ela, os modelos da Formatação saem sem imagem.'
            : 'Cadastre a arte do WhatsApp desta marca: sem ela, os modelos saem sem a logo.'}
        </Alert>
      )}

      {canEdit && (
        <div className="wa-art-actions">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            aria-label={art ? 'Trocar a arte' : 'Enviar a arte'}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) upload.mutate(file);
            }}
          />
          <Button type="button" onClick={() => input.current?.click()} disabled={busy}>
            {upload.isPending ? 'Enviando…' : art ? 'Trocar a arte' : 'Enviar a arte'}
          </Button>
          {art && (
            <Button type="button" variant="ghost" onClick={() => remove.mutate()} disabled={busy}>
              Tirar a arte
            </Button>
          )}
        </div>
      )}
      {upload.error && (
        <Alert kind="error">{errorText(upload.error, 'A arte não foi aceita.')}</Alert>
      )}
      {remove.error && (
        <Alert kind="error">{errorText(remove.error, 'Não deu para tirar a arte.')}</Alert>
      )}

      {!wings && (
        <div className="wa-art-article">
          <Field
            label="Artigo do nome nos modelos"
            hint={
              state.data && state.data.article === null
                ? 'Não informado: os modelos usam "da". Cadastre o artigo desta marca.'
                : 'Como o nome entra nos modelos: "do time de expansão da Malkuth".'
            }
          >
            <Select
              value={state.data?.article ?? ''}
              disabled={!canEdit || article.isPending || !state.data}
              onChange={(event) =>
                article.mutate((event.target.value || null) as BrandArticle | null)
              }
            >
              <option value="">Não informado</option>
              {BRAND_ARTICLES.map((value) => (
                <option key={value} value={value}>
                  {BRAND_ARTICLE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          {article.error && (
            <Alert kind="error">{errorText(article.error, 'Não deu para salvar o artigo.')}</Alert>
          )}
        </div>
      )}
      {state.isError && (
        <Alert kind="error">{errorText(state.error, 'Não deu para abrir a arte.')}</Alert>
      )}
    </section>
  );
}
