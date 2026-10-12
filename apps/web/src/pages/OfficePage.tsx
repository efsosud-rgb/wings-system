import { useOffice } from '../api/office.js';
import { PageHeader } from '../components/PageHeader.js';
import { OfficeFloor } from '../components/office3d/OfficeFloor.js';
import { LoadFailure } from '../components/LoadFailure.js';

/**
 * Laboratório → Escritório virtual (Admin Master). The company as a 3D office
 * fed by the CRM: each desk's monitor is the person's next task or deal, the
 * feed is what really happened, and a won sale is celebrated. The page reads
 * one snapshot a minute; nothing on it is invented.
 */
export function OfficePage() {
  const office = useOffice();

  return (
    <>
      <PageHeader
        title="Escritório virtual"
        subtitle="Laboratório · só o Admin Master vê. Tudo vem do CRM e da sessão de cada pessoa; sem dado, “—” e o motivo."
      />
      {office.isPending ? <p className="o3d-muted">Carregando o escritório…</p> : null}
      {office.isError ? (
        <LoadFailure
          what="o escritório"
          error={office.error}
          onRetry={() => void office.refetch()}
        />
      ) : null}
      {office.data ? <OfficeFloor snapshot={office.data} /> : null}
    </>
  );
}
