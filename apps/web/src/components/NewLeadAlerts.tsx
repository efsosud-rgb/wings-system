import type { NewLeadPopup } from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { useMarkNotificationsRead, useNewLeadPopups } from '../api/automations.js';
import {
  askNotificationPermission,
  notificationPermission,
  pageIsAway,
  playNewLeadSound,
  readDismissed,
  saveDismissed,
  showNewLeadNotification,
} from '../lib/new-lead-alert.js';
import { Icon } from './Icon.js';

/**
 * The pop-up for a new lead (Eric, 13/10/2026), over every screen of the system: the first name, the
 * funnel, the origin and the 1-hour deadline, with "Abrir ficha" and "Depois". Several stack, newest on
 * top. Only the lead's owner is ever sent one — the API decides, this just shows what it sent. A lead
 * that arrives while the tab is open also plays a short sound, and a system notification when the page
 * is away and the person allowed it. "Depois" puts it off in this browser; the notice stays unread in the
 * bell until the person opens the deal.
 */

const MAX_VISIBLE = 4;

const whenOf = (iso: string) => {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return `às ${time}`;
  return `em ${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
};

export function NewLeadAlerts() {
  const session = useSession();
  const allowed = hasPermission(session.data, 'leads.read');
  const popups = useNewLeadPopups(allowed);
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [permission, setPermission] = useState(notificationPermission);
  /** The notices already seen by this tab; null until the first answer, which is never announced. */
  const seen = useRef<Set<string> | null>(null);
  const dismissedNow = useRef(dismissed);
  dismissedNow.current = dismissed;

  const openDeal = (lead: NewLeadPopup) => {
    markRead.mutate([lead.noticeId]);
    navigate(`/crm-vendas/negociacoes/${lead.leadId}`);
  };
  const openDealRef = useRef(openDeal);
  openDealRef.current = openDeal;

  useEffect(() => {
    const leads = popups.data?.leads;
    if (!leads) return;
    if (seen.current !== null) {
      const fresh = leads.filter(
        (lead) => !seen.current!.has(lead.noticeId) && !dismissedNow.current.has(lead.noticeId),
      );
      if (fresh.length > 0) {
        playNewLeadSound();
        if (pageIsAway())
          for (const lead of fresh) showNewLeadNotification(lead, () => openDealRef.current(lead));
      }
    }
    seen.current = new Set([...(seen.current ?? []), ...leads.map((lead) => lead.noticeId)]);
  }, [popups.data]);

  const later = (lead: NewLeadPopup) => {
    const next = new Set(dismissed).add(lead.noticeId);
    setDismissed(next);
    saveDismissed(next);
  };

  const pending = (popups.data?.leads ?? []).filter((lead) => !dismissed.has(lead.noticeId));
  if (!allowed || pending.length === 0) return null;
  const visible = pending.slice(0, MAX_VISIBLE);

  return createPortal(
    <section className="crm-lead-pop-dock" aria-label="Leads novos" aria-live="polite">
      {visible.map((lead) => (
        <article key={lead.noticeId} className="crm-lead-pop" aria-label="Lead novo">
          <div className="crm-lead-pop-head">
            <Icon name="bell" size={16} />
            <span>Lead novo</span>
          </div>
          <strong className="crm-lead-pop-name">{lead.firstName || 'Sem nome'}</strong>
          <dl className="crm-lead-pop-facts">
            <dt>Funil</dt>
            <dd>{lead.funnel}</dd>
            <dt>Origem</dt>
            <dd>{lead.origin}</dd>
            <dt>Prazo</dt>
            <dd>
              1 hora útil
              {lead.firstContactDueAt ? ` — até ${whenOf(lead.firstContactDueAt)}` : ''}
            </dd>
          </dl>
          <div className="crm-lead-pop-actions">
            <button type="button" className="crm-btn" onClick={() => later(lead)}>
              Depois
            </button>
            <button
              type="button"
              className="crm-btn is-primary"
              onClick={() => {
                later(lead);
                openDeal(lead);
              }}
            >
              Abrir ficha
            </button>
          </div>
        </article>
      ))}
      {pending.length > MAX_VISIBLE && (
        <Link to="/crm-vendas/avisos" className="crm-lead-pop-more">
          + {pending.length - MAX_VISIBLE} lead{pending.length - MAX_VISIBLE === 1 ? '' : 's'} novo
          {pending.length - MAX_VISIBLE === 1 ? '' : 's'} — ver avisos
        </Link>
      )}
      {permission === 'default' && (
        <button
          type="button"
          className="crm-lead-pop-more"
          onClick={() => void askNotificationPermission().then(setPermission)}
        >
          Avisar também quando esta aba estiver em segundo plano
        </button>
      )}
    </section>,
    document.body,
  );
}
