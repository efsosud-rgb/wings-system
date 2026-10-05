import {
  CSV_IMPORT_FIELD_LABELS,
  CSV_IMPORT_FIELDS,
  LEAD_PIPELINE_LABELS,
  type CsvImportField,
  type CsvImportPreview,
  type CsvImportReport,
  type LeadPipeline,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useBrands, usePreviewImport, useRunImport } from '../../api/crm.js';
import { Modal } from './CreateDealModal.js';

/**
 * Import a spreadsheet: pick the file, see what the server made of it
 * (columns matched to fields, rows that would import, join an existing deal,
 * or be skipped and why), fix the mapping, then run. Nothing is written
 * before the person clicks "Importar".
 */
export function ImportModal({
  pipeline,
  onClose,
}: {
  pipeline: LeadPipeline;
  onClose: () => void;
}) {
  const preview = usePreviewImport();
  const run = useRunImport();
  const brands = useBrands();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, CsvImportField | ''>>({});
  const [brandClientId, setBrandClientId] = useState('');
  const data: CsvImportPreview | undefined = preview.data;
  const report: CsvImportReport | undefined = run.data;

  const load = async (file: File) => {
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    preview.mutate({ csv: text }, { onSuccess: (answer) => setMapping(answer.suggestedMapping) });
  };
  const cleanMapping = Object.fromEntries(
    Object.entries(mapping).filter((entry): entry is [string, CsvImportField] => Boolean(entry[1])),
  );
  const repreview = (next: Record<string, CsvImportField | ''>) => {
    setMapping(next);
    const clean = Object.fromEntries(
      Object.entries(next).filter((entry): entry is [string, CsvImportField] => Boolean(entry[1])),
    );
    preview.mutate({ csv, mapping: clean });
  };
  const error = preview.error ?? run.error;

  return (
    <Modal title="Importar planilha" onClose={onClose}>
      {!report && (
        <>
          <label className="crm-field">
            <span>Arquivo CSV (separado por ; ou ,), com cabeçalho na primeira linha</span>
            <input
              className="crm-input"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => event.target.files?.[0] && void load(event.target.files[0])}
            />
          </label>
          {preview.isPending && <p className="crm-muted">Lendo {fileName}…</p>}
          {data && (
            <>
              <div className="crm-form-grid">
                {data.headers.map((header) => (
                  <label key={header} className="crm-field">
                    <span>Coluna “{header}”</span>
                    <select
                      className="crm-select"
                      value={mapping[header] ?? ''}
                      onChange={(event) =>
                        repreview({
                          ...mapping,
                          [header]: event.target.value as CsvImportField | '',
                        })
                      }
                    >
                      <option value="">Ignorar</option>
                      {CSV_IMPORT_FIELDS.map((field) => (
                        <option key={field} value={field}>
                          {CSV_IMPORT_FIELD_LABELS[field]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="crm-form-grid">
                <label className="crm-field">
                  <span>Funil das linhas sem funil</span>
                  <input className="crm-input" value={LEAD_PIPELINE_LABELS[pipeline]} readOnly />
                </label>
                {pipeline === 'expansao' && (
                  <label className="crm-field">
                    <span>Marca das linhas sem marca</span>
                    <select
                      className="crm-select"
                      value={brandClientId}
                      onChange={(event) => setBrandClientId(event.target.value)}
                    >
                      <option value="">Nenhuma</option>
                      {(brands.data?.brands ?? []).map((brand) => (
                        <option key={brand.clientId} value={brand.clientId}>
                          {brand.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <p className="crm-sub">
                {data.rows} linhas · <b>{data.valid}</b> prontas para importar · {data.existing}{' '}
                juntam-se a negociações que já existem · {data.repeated} repetidas no arquivo ·{' '}
                {data.invalid} com erro
              </p>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Linha</th>
                    <th>Nome</th>
                    <th>Contato</th>
                    <th>Empresa</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sample.map((row) => (
                    <tr key={row.line}>
                      <td className="is-num">{row.line}</td>
                      <td>{row.values.name || <span className="crm-muted">—</span>}</td>
                      <td>
                        {row.values.phone || row.values.email || (
                          <span className="crm-muted">—</span>
                        )}
                      </td>
                      <td>{row.values.company || <span className="crm-muted">—</span>}</td>
                      <td>
                        {row.errors.length > 0 ? (
                          <span className="crm-status is-lost">{row.errors.join('; ')}</span>
                        ) : row.matchesLeadId ? (
                          <span className="crm-status">Junta-se a uma negociação existente</span>
                        ) : (
                          <span className="crm-status is-won">Nova</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows > data.sample.length && (
                <p className="crm-muted">Prévia das primeiras {data.sample.length} linhas.</p>
              )}
            </>
          )}
          {error && (
            <p className="crm-error">
              {error instanceof ApiError ? error.message : 'Não foi possível ler o arquivo.'}
            </p>
          )}
          <div className="crm-form-actions">
            <button type="button" className="crm-btn is-quiet" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="button"
              className="crm-btn is-primary"
              disabled={!data || data.valid + data.existing === 0 || run.isPending}
              onClick={() =>
                run.mutate({
                  csv,
                  mapping: cleanMapping,
                  pipeline,
                  brandClientId: brandClientId || undefined,
                })
              }
            >
              {run.isPending ? 'Importando…' : `Importar ${data ? data.valid : ''} linhas`}
            </button>
          </div>
        </>
      )}
      {report && (
        <>
          <p className="crm-ok">
            Importação concluída: {report.created} negociações novas, {report.matched} juntaram-se a
            existentes, {report.skipped} ignoradas.
          </p>
          {report.errors.length > 0 && (
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {report.errors.map((item) => (
                  <tr key={`${item.line}-${item.message}`}>
                    <td className="is-num">{item.line}</td>
                    <td>{item.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="crm-form-actions">
            <button type="button" className="crm-btn is-primary" onClick={onClose}>
              Fechar
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
