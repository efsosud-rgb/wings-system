import { LEAD_ENTERED_SOURCE_LABELS, type LeadEnteredSource } from '@wings/shared';
import { formatEntered } from './format.js';

/**
 * When a lead entered the CRM, in Brasília time, by the source's own clock. A source that brought
 * no date shows the moment the system received the lead, and says so.
 */
export function EnteredAt({ at, source }: { at: string; source: LeadEnteredSource }) {
  const received = source === 'received';
  return (
    <span
      title={
        received
          ? 'A fonte não trouxe a data: esta é a hora em que o sistema recebeu o lead.'
          : `Data da fonte: ${LEAD_ENTERED_SOURCE_LABELS[source]}`
      }
    >
      {formatEntered(at)}
      {received && <small className="crm-sub"> · recebido pelo sistema</small>}
    </span>
  );
}
