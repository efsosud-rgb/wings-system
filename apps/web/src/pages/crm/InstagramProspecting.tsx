import {
  approximateAgoText,
  PASTE_DISCARD_KINDS,
  PASTE_DISCARD_LABELS,
  PASTE_IGNORED_KINDS,
  PASTE_IGNORED_LABELS,
  type InstagramPasteInput,
  type PasteCommentTag,
  type PasteConfirmResponse,
  type PastePreviewResponse,
} from '@wings/shared';
import { useState, type FormEvent } from 'react';
import {
  useAttachComment,
  useConfirmPaste,
  useInstagramStatus,
  usePreviewPaste,
} from '../../api/prospect-ai.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { actionFailure, InstagramLists, InstagramSettings } from './InstagramProspectList.js';
import { WingsComments } from './InstagramWingsComments.js';

/**
 * Prospecção → Instagram, parte 2 (docs/prospeccao/instagram.md §1.2): the seller pastes the
 * comments she copied by hand from a competitor's post, sees what was read, confirms, and works
 * the lists by hand in the Direct. The system never opens Instagram nor sends anything.
 */

const TAG_TEXT = (tag: PasteCommentTag): string => {
  switch (tag.kind) {
    case 'nao_contatar':
      return 'não contatar';
    case 'cliente':
      return 'já é cliente';
    case 'lead':
      return `já é lead${tag.ownerName ? ` de ${tag.ownerName.split(' ')[0]}` : ''}`;
    case 'prospect':
      return tag.ownerName
        ? `já está na lista de ${tag.ownerName.split(' ')[0]}`
        : 'já está na lista de outro vendedor';
  }
};

type View = 'paste' | 'lists' | 'wings' | 'settings';

export function InstagramTab({
  canPaste,
  canManage,
  canConfigure,
}: {
  canPaste: boolean;
  canManage: boolean;
  canConfigure: boolean;
}) {
  const status = useInstagramStatus();
  const [chosen, setView] = useState<View | null>(null);
  const [batch, setBatch] = useState<string | null>(null);

  if (status.isError)
    return (
      <LoadFailure
        what="a Prospecção Instagram"
        error={status.error}
        onRetry={() => void status.refetch()}
      />
    );
  if (!status.data) return <p className="muted">Carregando…</p>;
  const pasteOn = status.data.enabled;
  // Comentários da Wings (parte 1) has its own switches: it shows even with the paste off.
  const views: [View, string][] = [
    ...(pasteOn && canPaste ? [['paste', 'Colar comentários'] as [View, string]] : []),
    ...(pasteOn ? [['lists', canManage ? 'Listas' : 'Minhas listas'] as [View, string]] : []),
    ['wings', 'Comentários da Wings'],
    ...(canConfigure ? [['settings', 'Ajustes'] as [View, string]] : []),
  ];
  const view = chosen && views.some(([key]) => key === chosen) ? chosen : views[0]![0];
  return (
    <div className="crm-stack">
      {!pasteOn && (
        <p className="load-failure" role="status">
          <span className="load-failure-dash" aria-hidden="true">
            —
          </span>
          <span>
            Colar comentários desligado: espera o OK do Jurídico (abordar pessoas reais) e a
            política de privacidade publicada. Quem liga é o Eric.
          </span>
        </p>
      )}
      <div className="crm-quick-row" role="group" aria-label="Instagram">
        {views.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`crm-btn is-small ${view === key ? 'is-primary' : 'is-quiet'}`}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'paste' && (
        <PasteForm
          aiEnabled={status.data.aiEnabled}
          pastesLeft={Math.max(
            0,
            status.data.settings.paste.perSellerPerDay - status.data.pastesToday,
          )}
          onDone={(id) => {
            setBatch(id);
            setView('lists');
          }}
        />
      )}
      {view === 'lists' && (
        <InstagramLists
          canManage={canManage}
          canWrite={canPaste}
          batch={batch}
          setBatch={setBatch}
        />
      )}
      {view === 'wings' && (
        <WingsComments
          canManage={canManage}
          canWrite={canPaste}
          webhookEnabled={status.data.webhookEnabled}
          replyEnabled={status.data.replyEnabled}
        />
      )}
      {view === 'settings' && <InstagramSettings settings={status.data.settings} />}
    </div>
  );
}

const EMPTY: InstagramPasteInput = { text: '', postUrl: '', postOwner: '' };

function PasteForm({
  aiEnabled,
  pastesLeft,
  onDone,
}: {
  aiEnabled: boolean;
  pastesLeft: number;
  onDone: (batchId: string) => void;
}) {
  const [form, setForm] = useState<InstagramPasteInput>(EMPTY);
  const preview = usePreviewPaste();
  const confirm = useConfirmPaste();
  const [done, setDone] = useState<PasteConfirmResponse | null>(null);

  const read = (event: FormEvent) => {
    event.preventDefault();
    setDone(null);
    confirm.reset();
    preview.mutate(form);
  };
  const separate = () =>
    confirm.mutate(form, {
      onSuccess: (answer) => {
        setDone(answer);
        // The text is dropped from the screen too, once it was used.
        setForm(EMPTY);
        preview.reset();
      },
    });

  return (
    <div className="crm-stack">
      <form className="crm-panel crm-stack" onSubmit={read}>
        <p className="crm-sub">
          Copie os comentários de um post de concorrente ou de uma marca do nicho, no Instagram, e
          cole aqui. O sistema não entra no Instagram e não guarda o texto colado. Pelo app, escreva
          um por linha: <code>@usuario: texto</code>.
        </p>
        <div className="crm-form-grid">
          <label className="crm-field is-wide">
            <span>Link do post (obrigatório)</span>
            <input
              className="crm-input"
              required
              placeholder="https://www.instagram.com/p/…"
              value={form.postUrl}
              onChange={(e) => setForm((c) => ({ ...c, postUrl: e.target.value }))}
            />
          </label>
          <label className="crm-field">
            <span>@ do dono do post (se souber)</span>
            <input
              className="crm-input"
              value={form.postOwner}
              onChange={(e) => setForm((c) => ({ ...c, postOwner: e.target.value }))}
            />
          </label>
          <label className="crm-field is-wide">
            <span>Comentários colados</span>
            <textarea
              className="crm-input"
              rows={10}
              required
              value={form.text}
              onChange={(e) => setForm((c) => ({ ...c, text: e.target.value }))}
            />
          </label>
        </div>
        <p className="field-hint">
          Colagens que restam hoje: {pastesLeft}. IA{' '}
          {aiEnabled ? 'ligada' : 'desligada: o que as regras não decidirem vai para "Revisar"'}.
        </p>
        {preview.isError && (
          <p className="crm-error" role="alert">
            {actionFailure(preview.error)}
          </p>
        )}
        <div className="crm-form-actions">
          <button type="submit" className="crm-btn is-primary" disabled={preview.isPending}>
            {preview.isPending ? 'Lendo…' : 'Ler comentários'}
          </button>
        </div>
      </form>
      {preview.data && (
        <Preview
          data={preview.data}
          input={form}
          busy={confirm.isPending}
          onConfirm={separate}
          error={confirm.isError ? actionFailure(confirm.error) : null}
          pastesLeft={pastesLeft}
        />
      )}
      {done && (
        <div className="crm-panel crm-stack" role="status">
          <p>
            Pronto: {done.created} novos ({done.lists.querComprar} em "Quer comprar",{' '}
            {done.lists.revisar} em "Revisar"), {done.joined} juntados a um prospect que já estava
            aberto, {done.repeated} repetidos e {done.skippedKnown} já conhecidos.
          </p>
          <button type="button" className="crm-btn is-primary" onClick={() => onDone(done.batchId)}>
            Ver a lista desta colagem
          </button>
        </div>
      )}
    </div>
  );
}

function Preview({
  data,
  input,
  busy,
  onConfirm,
  error,
  pastesLeft,
}: {
  data: PastePreviewResponse;
  input: InstagramPasteInput;
  busy: boolean;
  onConfirm: () => void;
  error: string | null;
  pastesLeft: number;
}) {
  const attach = useAttachComment();
  const [attached, setAttached] = useState<string[]>([]);
  const ignored = PASTE_IGNORED_KINDS.filter((k) => data.ignored[k] > 0);
  const discarded = PASTE_DISCARD_KINDS.filter((k) => data.discarded[k] > 0);
  const now = new Date();
  return (
    <section className="crm-panel crm-stack" aria-label="Prévia da colagem">
      <p>
        <strong>{data.comments.length}</strong> comentários reconhecidos ·{' '}
        <strong>{data.linesIgnored}</strong> linhas ignoradas ·{' '}
        <strong>{data.linesUnrecognized}</strong> não reconhecidas. Nada foi gravado ainda.
      </p>
      {(ignored.length > 0 || discarded.length > 0) && (
        <p className="crm-sub">
          Ignorado: {ignored.map((k) => `${data.ignored[k]} ${PASTE_IGNORED_LABELS[k]}`).join(', ')}
          {ignored.length > 0 && discarded.length > 0 ? '; ' : ''}
          {discarded.map((k) => `${data.discarded[k]} ${PASTE_DISCARD_LABELS[k]}`).join(', ')}.
        </p>
      )}
      {data.linesUnrecognized > 0 && (
        <details>
          <summary>
            Linhas não reconhecidas ({data.linesUnrecognized}; as primeiras{' '}
            {data.unrecognized.length})
          </summary>
          <ul>
            {data.unrecognized.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="crm-sub">
        Já conhecidos (não viram prospect): {data.alreadyKnown.naoContatar} não contatar,{' '}
        {data.alreadyKnown.cliente} clientes, {data.alreadyKnown.lead} leads. Em lista de alguém:{' '}
        {data.alreadyKnown.prospect}.
        {data.estimatedCostMicroUsd !== null &&
          ` Custo estimado da IA: US$ ${(data.estimatedCostMicroUsd / 1e6).toFixed(4)}.`}
      </p>
      <table className="crm-table">
        <thead>
          <tr>
            <th>@</th>
            <th>Comentário</th>
            <th>Quando</th>
            <th>Na base</th>
          </tr>
        </thead>
        <tbody>
          {data.comments.map((c, i) => (
            <tr key={i}>
              <td>{c.username === '—' ? '—' : `@${c.username}`}</td>
              <td>{c.excerpt || '—'}</td>
              <td>{approximateAgoText(new Date(c.occurredAt), now)}</td>
              <td>
                {c.tag ? TAG_TEXT(c.tag) : '—'}
                {c.tag?.kind === 'lead' && c.tag.leadId && (
                  <button
                    type="button"
                    className="link-button"
                    disabled={attach.isPending || attached.includes(c.username)}
                    onClick={() =>
                      attach.mutate(
                        {
                          leadId: (c.tag as { leadId: string }).leadId,
                          postUrl: data.postUrl,
                          username: c.username,
                          text: c.excerpt,
                          when: c.when,
                        },
                        { onSuccess: () => setAttached((a) => [...a, c.username]) },
                      )
                    }
                  >
                    {attached.includes(c.username) ? ' anexado' : ' anexar ao lead'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {attach.isError && (
        <p className="crm-error" role="alert">
          {actionFailure(attach.error)}
        </p>
      )}
      {error && (
        <p className="crm-error" role="alert">
          {error}
        </p>
      )}
      <div className="crm-form-actions">
        <button
          type="button"
          className="crm-btn is-primary"
          disabled={busy || data.usable === 0 || pastesLeft === 0 || !input.text}
          onClick={onConfirm}
        >
          {busy ? 'Separando…' : `Separar quem quer comprar (${data.usable} comentários)`}
        </button>
      </div>
    </section>
  );
}
