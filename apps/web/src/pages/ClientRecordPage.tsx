import {
  CLIENT_CONTACT_ROLES,
  CLIENT_CONTACT_ROLE_LABELS,
  CLIENT_MAX_WITNESSES,
  CLIENT_RECORD_BLOCKS,
  CLIENT_RECORD_BLOCK_LABELS,
  CONSULTANT_AREAS,
  EMPTY_ADDRESS,
  INPI_STATUSES,
  INPI_STATUS_LABELS,
  MARITAL_STATUSES,
  MARITAL_STATUSES_WITH_REGIME,
  MARITAL_STATUS_LABELS,
  PROPERTY_REGIMES,
  PROPERTY_REGIME_LABELS,
  REVENUE_BANDS,
  REVENUE_BAND_LABELS,
  SECTORS,
  SIGNATURE_TYPES,
  SIGNATURE_TYPE_LABELS,
  SOCIAL_NETWORKS,
  TAX_REGIMES,
  TAX_REGIME_LABELS,
  formatCnpj,
  formatCpf,
  formatExpansionEntry,
  isValidCnpj,
  type ClientBusiness,
  type ClientCompany,
  type ClientContact,
  type ClientContactRole,
  type ClientContract,
  type ClientFranchise,
  type ClientPartner,
  type ClientPartnerInput,
  type ClientRecord,
  type ClientRecordBlock,
  type ClientUnitModel,
  type ConsultantArea,
  type MaritalStatus,
  type PropertyRegime,
  type SignatureType,
  type SocialNetwork,
} from '@wings/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useClientRecord,
  useCnpjLookup,
  useDeletePartner,
  useRevealClientCpf,
  useSaveClientBlock,
  useSavePartner,
  type CnpjLookup,
} from '../api/clients.js';
import {
  AddressFields,
  ChoiceField,
  IntegerField,
  MoneyField,
  PercentField,
  TextField,
} from '../components/clients/RecordFields.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';

/**
 * Formatação → Clientes → ficha. The client's full record, one tab per
 * block, each saved on its own. The API answers every save with the whole
 * record, so the "% preenchido" moves as soon as a block is saved.
 *
 * CPF, estado civil and regime de bens are Jurídico's, Diretoria's and Admin
 * Master's: everyone else sees that they exist, never what they are.
 */

const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** A block's form: its own save button, the answer or the refusal under it. */
function BlockForm({
  onSubmit,
  pending,
  error,
  saved,
  canEdit,
  children,
}: {
  onSubmit: () => void;
  pending: boolean;
  error: unknown;
  saved: boolean;
  canEdit: boolean;
  children: ReactNode;
}) {
  return (
    <form
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset className="record-fieldset" disabled={!canEdit}>
        {children}
      </fieldset>
      {error ? <Alert kind="error">{errorText(error, 'Não foi possível salvar.')}</Alert> : null}
      {canEdit && (
        <div className="record-actions">
          <Button type="submit" disabled={pending}>
            {pending ? 'Salvando…' : 'Salvar'}
          </Button>
          {saved && !pending && <span className="field-hint">Salvo.</span>}
        </div>
      )}
    </form>
  );
}

function Missing({ record, block }: { record: ClientRecord; block: ClientRecordBlock }) {
  const entry = record.completeness.blocks.find((item) => item.block === block);
  if (!entry || entry.missing.length === 0) return <p className="record-missing record-missing-done">Bloco completo.</p>;
  return (
    <p className="record-missing">
      <strong>Falta:</strong> {entry.missing.join(' · ')}
    </p>
  );
}

// --- 1. Empresa ------------------------------------------------------------------------

function CompanyBlock({ record, onPartnerSuggestion }: { record: ClientRecord; onPartnerSuggestion: (name: string) => void }) {
  const save = useSaveClientBlock<ClientCompany>(record.client.id, 'company');
  const lookup = useCnpjLookup();
  const [draft, setDraft] = useState<ClientCompany>(record.company);
  const [found, setFound] = useState<CnpjLookup | null>(null);
  const set = (patch: Partial<ClientCompany>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const cnpjOk = draft.cnpj !== null && isValidCnpj(draft.cnpj);
  const secondary = draft.cnaeSecondary.join('\n');

  return (
    <BlockForm
      onSubmit={() => save.mutate(draft)}
      pending={save.isPending}
      error={save.error}
      saved={save.isSuccess}
      canEdit={record.access.canEdit}
    >
      <div className="grid-3">
        <Field
          label="CNPJ"
          hint="Buscar preenche com os dados da Receita; confira antes de salvar."
          error={
            lookup.error
              ? errorText(lookup.error, 'Não foi possível consultar o CNPJ.')
              : draft.cnpj && !cnpjOk
                ? 'CNPJ inválido'
                : undefined
          }
        >
          <div className="input-row">
            <Input
              value={draft.cnpj ? formatCnpj(draft.cnpj) : ''}
              placeholder="00.000.000/0000-00"
              onChange={(event) => {
                lookup.reset();
                set({ cnpj: event.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 14) || null });
              }}
            />
            <Button
              type="button"
              variant="ghost"
              disabled={!cnpjOk || lookup.isPending}
              onClick={() =>
                lookup.mutate(draft.cnpj as string, {
                  onSuccess: (answer) => {
                    setFound(answer);
                    const filled = Object.fromEntries(
                      Object.entries(answer.company).filter(([, value]) =>
                        Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined,
                      ),
                    ) as Partial<ClientCompany>;
                    set({
                      ...filled,
                      address: { ...draft.address, ...Object.fromEntries(Object.entries(answer.company.address ?? {}).filter(([, v]) => v)) },
                    });
                  },
                })
              }
            >
              {lookup.isPending ? 'Buscando…' : 'Buscar na Receita'}
            </Button>
          </div>
        </Field>
        <TextField label="Razão social" value={draft.legalName} onChange={(legalName) => set({ legalName })} />
        <TextField label="Nome fantasia" value={draft.tradeName} onChange={(tradeName) => set({ tradeName })} />
      </div>

      {found && (
        <Alert kind={found.registrationStatus === 'ATIVA' ? 'info' : 'warning'}>
          Receita ({found.source === 'brasilapi' ? 'BrasilAPI' : 'ReceitaWS'}): situação{' '}
          <strong>{found.registrationStatus ?? 'não informada'}</strong>.
          {found.partners.length > 0 && (
            <span className="record-qsa">
              {' '}
              Quadro de sócios:{' '}
              {found.partners.map((partner) => (
                <span key={partner.name} className="record-qsa-item">
                  {partner.name}
                  {partner.role ? ` (${partner.role})` : ''}
                  {record.access.canEdit && !record.partners.some((p) => p.name.toUpperCase() === partner.name.toUpperCase()) && (
                    <button type="button" className="link-button" onClick={() => onPartnerSuggestion(partner.name)}>
                      adicionar como sócio
                    </button>
                  )}
                </span>
              ))}
            </span>
          )}
        </Alert>
      )}

      <div className="grid-3">
        <TextField label="Inscrição estadual" value={draft.stateRegistration} onChange={(stateRegistration) => set({ stateRegistration })} hint="Ou “isento”." />
        <TextField label="Inscrição municipal" value={draft.municipalRegistration} onChange={(municipalRegistration) => set({ municipalRegistration })} />
        <TextField label="Data de abertura" type="date" value={draft.openedOn} onChange={(openedOn) => set({ openedOn })} />
        <TextField label="Natureza jurídica" value={draft.legalNature} onChange={(legalNature) => set({ legalNature })} placeholder="206-2 - Sociedade Empresária Limitada" />
        <ChoiceField label="Regime tributário" value={draft.taxRegime} onChange={(taxRegime) => set({ taxRegime })} options={TAX_REGIMES} labels={TAX_REGIME_LABELS} />
        <MoneyField label="Capital social" value={draft.shareCapitalCents} onChange={(shareCapitalCents) => set({ shareCapitalCents })} />
      </div>
      <div className="grid-2">
        <TextField label="CNAE principal" value={draft.cnaeMain} onChange={(cnaeMain) => set({ cnaeMain })} placeholder="5611-2/03 Lanchonetes…" />
        <Field label="CNAEs secundários" hint="Um por linha.">
          <textarea
            className="control"
            rows={3}
            value={secondary}
            onChange={(event) =>
              set({ cnaeSecondary: event.target.value.split('\n').map((line) => line.trimStart()).filter((line, i, all) => line || i === all.length - 1) })
            }
            onBlur={() => set({ cnaeSecondary: draft.cnaeSecondary.map((line) => line.trim()).filter(Boolean) })}
          />
        </Field>
      </div>

      <h3 className="record-subhead">Endereço</h3>
      <AddressFields value={draft.address} onChange={(address) => set({ address })} />

      <h3 className="record-subhead">Contato da empresa</h3>
      <div className="grid-3">
        <TextField label="Telefone" type="tel" value={draft.phone} onChange={(phone) => set({ phone })} placeholder="(11) 3333-4444" />
        <TextField label="E-mail" type="email" value={draft.email} onChange={(email) => set({ email })} />
        <TextField label="Site" value={draft.website} onChange={(website) => set({ website })} placeholder="https://" />
        {SOCIAL_NETWORKS.map((network) => (
          <TextField
            key={network}
            label={SOCIAL_LABELS[network]}
            value={draft.social[network] ?? null}
            onChange={(handle) => set({ social: { ...draft.social, [network]: handle ?? '' } })}
            placeholder="@perfil ou endereço"
          />
        ))}
      </div>
    </BlockForm>
  );
}

// --- 2. Sócios ----------------------------------------------------------------------------

type PartnerDraft = Omit<ClientPartnerInput, 'cpf'> & { cpf: string };

const partnerDraftOf = (partner: ClientPartner | null, name = ''): PartnerDraft => ({
  name: partner?.name ?? name,
  cpf: '',
  rg: partner?.rg ?? null,
  rgIssuer: partner?.rgIssuer ?? null,
  nationality: partner?.nationality ?? 'brasileira',
  profession: partner?.profession ?? null,
  maritalStatus: partner?.maritalStatus ?? null,
  propertyRegime: partner?.propertyRegime ?? null,
  address: partner?.address ?? EMPTY_ADDRESS,
  email: partner?.email ?? null,
  mobile: partner?.mobile ?? null,
  sharePercent: partner?.sharePercent ?? null,
  signsForCompany: partner?.signsForCompany ?? false,
});

function PartnerCard({
  record,
  partner,
  initialName,
  onDone,
}: {
  record: ClientRecord;
  partner: ClientPartner | null;
  initialName?: string;
  onDone?: () => void;
}) {
  const clientId = record.client.id;
  const save = useSavePartner(clientId);
  const remove = useDeletePartner(clientId);
  const reveal = useRevealClientCpf(clientId);
  const [draft, setDraft] = useState<PartnerDraft>(partnerDraftOf(partner, initialName));
  const sensitive = record.access.canSeeSensitive;
  const set = (patch: Partial<PartnerDraft>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const needsRegime = draft.maritalStatus ? MARITAL_STATUSES_WITH_REGIME.includes(draft.maritalStatus) : false;

  const submit = () => {
    const { cpf, maritalStatus, propertyRegime, ...rest } = draft;
    // Only who may see the sensitive fields sends them; an empty CPF keeps the stored one.
    const payload: ClientPartnerInput = sensitive
      ? {
          ...rest,
          ...(cpf.trim() ? { cpf } : {}),
          maritalStatus,
          propertyRegime: needsRegime ? propertyRegime : null,
        }
      : rest;
    save.mutate(
      { partnerId: partner?.id ?? null, payload },
      {
        onSuccess: () => {
          setDraft((current) => ({ ...current, cpf: '' }));
          onDone?.();
        },
      },
    );
  };

  return (
    <fieldset className="block record-partner">
      <legend>{partner ? `Sócio ${partner.position}` : 'Novo sócio'}</legend>
      <BlockForm onSubmit={submit} pending={save.isPending} error={save.error ?? remove.error} saved={save.isSuccess} canEdit={record.access.canEdit}>
        <div className="grid-3">
          <TextField label="Nome completo" value={draft.name} onChange={(name) => set({ name: name ?? '' })} />
          {sensitive ? (
            <Field
              label="CPF"
              hint={partner?.cpfOnFile ? 'Preencha só para trocar o CPF.' : undefined}
            >
              <div className="input-row">
                <Input
                  value={draft.cpf}
                  inputMode="numeric"
                  placeholder={partner?.cpfMasked ?? '000.000.000-00'}
                  onChange={(event) => set({ cpf: event.target.value })}
                />
                {partner?.cpfOnFile && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={reveal.isPending}
                    onClick={() => reveal.mutate({ kind: 'partner', id: partner.id })}
                  >
                    {reveal.isPending ? '…' : 'Revelar'}
                  </Button>
                )}
              </div>
              {reveal.data && (
                <span className="field-hint reveal">
                  CPF completo: <strong className="mono">{formatCpf(reveal.data.cpf)}</strong> — esta exibição foi
                  registrada no log de auditoria.
                </span>
              )}
            </Field>
          ) : (
            <Field label="CPF" hint="Restrito ao Jurídico, Diretoria e Admin Master.">
              <Input value={partner?.cpfOnFile ? 'Informado' : 'Não informado'} disabled readOnly />
            </Field>
          )}
          <TextField label="RG" value={draft.rg ?? null} onChange={(rg) => set({ rg })} />
          <TextField label="Órgão emissor" value={draft.rgIssuer ?? null} onChange={(rgIssuer) => set({ rgIssuer })} placeholder="SSP/SP" />
          <TextField label="Nacionalidade" value={draft.nationality ?? null} onChange={(nationality) => set({ nationality })} />
          <TextField label="Profissão" value={draft.profession ?? null} onChange={(profession) => set({ profession })} />
          {sensitive ? (
            <>
              <ChoiceField<MaritalStatus>
                label="Estado civil"
                value={draft.maritalStatus ?? null}
                onChange={(maritalStatus) => set({ maritalStatus })}
                options={MARITAL_STATUSES}
                labels={MARITAL_STATUS_LABELS}
              />
              {needsRegime && (
                <ChoiceField<PropertyRegime>
                  label="Regime de bens"
                  value={draft.propertyRegime ?? null}
                  onChange={(propertyRegime) => set({ propertyRegime })}
                  options={PROPERTY_REGIMES}
                  labels={PROPERTY_REGIME_LABELS}
                />
              )}
            </>
          ) : (
            <Field label="Estado civil e regime de bens" hint="Restrito ao Jurídico, Diretoria e Admin Master.">
              <Input value="Restrito" disabled readOnly />
            </Field>
          )}
          <TextField label="E-mail" type="email" value={draft.email ?? null} onChange={(email) => set({ email })} />
          <TextField label="Celular" type="tel" value={draft.mobile ?? null} onChange={(mobile) => set({ mobile })} placeholder="(11) 99999-9999" />
          <PercentField label="Participação" value={draft.sharePercent ?? null} onChange={(sharePercent) => set({ sharePercent })} />
          <Field label="Assina pela empresa">
            <Select
              value={draft.signsForCompany ? 'sim' : 'nao'}
              onChange={(event) => set({ signsForCompany: event.target.value === 'sim' })}
            >
              <option value="nao">Não</option>
              <option value="sim">Sim</option>
            </Select>
          </Field>
        </div>
        <h3 className="record-subhead">Endereço</h3>
        <AddressFields value={{ ...EMPTY_ADDRESS, ...draft.address }} onChange={(address) => set({ address })} />
      </BlockForm>
      {record.access.canEdit && (
        <div className="record-actions">
          {partner ? (
            <Button
              type="button"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remover ${partner.name} dos sócios deste cliente?`)) remove.mutate(partner.id);
              }}
            >
              Remover sócio
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancelar
            </Button>
          )}
        </div>
      )}
    </fieldset>
  );
}

function PartnersBlock({
  record,
  adding,
  setAdding,
}: {
  record: ClientRecord;
  adding: string | null;
  setAdding: (name: string | null) => void;
}) {
  const total = record.partners.reduce((sum, partner) => sum + (partner.sharePercent ?? 0), 0);
  return (
    <>
      {!record.access.canSeeSensitive && (
        <Alert kind="info">CPF, estado civil e regime de bens dos sócios são preenchidos pelo Jurídico, Diretoria ou Admin Master.</Alert>
      )}
      {record.partners.length > 0 && (
        <p className="muted">
          Participações somadas: {total.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%
        </p>
      )}
      {record.partners.map((partner) => (
        <PartnerCard key={`${partner.id}-${partner.position}`} record={record} partner={partner} />
      ))}
      {adding !== null ? (
        <PartnerCard record={record} partner={null} initialName={adding} onDone={() => setAdding(null)} />
      ) : (
        record.access.canEdit && (
          <Button type="button" variant="ghost" onClick={() => setAdding('')}>
            Adicionar sócio
          </Button>
        )
      )}
    </>
  );
}

// --- 3. Contatos -------------------------------------------------------------------------

function ContactsBlock({ record }: { record: ClientRecord }) {
  const save = useSaveClientBlock<{ contacts: ClientContact[] }>(record.client.id, 'contacts');
  const blank = (role: ClientContactRole): ClientContact => ({ role, name: '', jobTitle: null, email: null, whatsapp: null });
  const [draft, setDraft] = useState<ClientContact[]>(
    CLIENT_CONTACT_ROLES.map((role) => record.contacts.find((contact) => contact.role === role) ?? blank(role)),
  );
  const set = (role: ClientContactRole, patch: Partial<ClientContact>) => {
    save.reset();
    setDraft((current) => current.map((contact) => (contact.role === role ? { ...contact, ...patch } : contact)));
  };
  return (
    <BlockForm
      // A contact without a name is not saved: the role stays empty.
      onSubmit={() => save.mutate({ contacts: draft.filter((contact) => contact.name.trim()) })}
      pending={save.isPending}
      error={save.error}
      saved={save.isSuccess}
      canEdit={record.access.canEdit}
    >
      {draft.map((contact) => (
        <div key={contact.role}>
          <h3 className="record-subhead">{CLIENT_CONTACT_ROLE_LABELS[contact.role]}</h3>
          <div className="grid-3">
            <TextField label="Nome" value={contact.name} onChange={(name) => set(contact.role, { name: name ?? '' })} />
            <TextField label="Cargo" value={contact.jobTitle} onChange={(jobTitle) => set(contact.role, { jobTitle })} />
            <TextField label="E-mail" type="email" value={contact.email} onChange={(email) => set(contact.role, { email })} />
            <TextField label="WhatsApp" type="tel" value={contact.whatsapp} onChange={(whatsapp) => set(contact.role, { whatsapp })} placeholder="(11) 99999-9999" />
          </div>
        </div>
      ))}
    </BlockForm>
  );
}

// --- 4. Negócio atual --------------------------------------------------------------------

function BusinessBlock({ record }: { record: ClientRecord }) {
  const save = useSaveClientBlock<ClientBusiness>(record.client.id, 'business');
  const [draft, setDraft] = useState<ClientBusiness>(record.business);
  const set = (patch: Partial<ClientBusiness>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  return (
    <BlockForm onSubmit={() => save.mutate(draft)} pending={save.isPending} error={save.error} saved={save.isSuccess} canEdit={record.access.canEdit}>
      <div className="grid-3">
        <TextField label="Segmento" value={draft.segment} onChange={(segment) => set({ segment })} placeholder="Alimentação, estética…" />
        <IntegerField label="Tempo de operação (anos)" value={draft.operatingYears} onChange={(operatingYears) => set({ operatingYears })} />
        <IntegerField label="Unidades próprias" value={draft.ownUnits} onChange={(ownUnits) => set({ ownUnits })} />
        <ChoiceField label="Faturamento anual" value={draft.revenueBand} onChange={(revenueBand) => set({ revenueBand })} options={REVENUE_BANDS} labels={REVENUE_BAND_LABELS} />
        <MoneyField label="Ticket médio" value={draft.averageTicketCents} onChange={(averageTicketCents) => set({ averageTicketCents })} />
        <IntegerField label="Nº de funcionários" value={draft.employeesCount} onChange={(employeesCount) => set({ employeesCount })} />
      </div>
      <TextField label="Descrição do negócio" multiline value={draft.description} onChange={(description) => set({ description })} />
      <h3 className="record-subhead">Marca no INPI</h3>
      <div className="grid-3">
        <ChoiceField label="Situação" value={draft.inpiStatus} onChange={(inpiStatus) => set({ inpiStatus })} options={INPI_STATUSES} labels={INPI_STATUS_LABELS} />
        <TextField label="Nº do processo" value={draft.inpiProcess} onChange={(inpiProcess) => set({ inpiProcess })} />
        <TextField label="Classe" value={draft.inpiClass} onChange={(inpiClass) => set({ inpiClass })} placeholder="NCL 43" />
      </div>
    </BlockForm>
  );
}

// --- 5. Contrato -------------------------------------------------------------------------

type ContractDraft = Omit<ClientContract, 'id'> & { id?: string };

const blankContract = (): ContractDraft => ({
  service: '',
  number: null,
  signedOn: null,
  valueCents: null,
  paymentMethod: null,
  installments: null,
  startsOn: null,
  termMonths: null,
  leadId: null,
  consultants: {},
});

function ContractsBlock({ record }: { record: ClientRecord }) {
  const save = useSaveClientBlock<{ contracts: ContractDraft[] }>(record.client.id, 'contracts');
  const [draft, setDraft] = useState<ContractDraft[]>(record.contracts.length ? record.contracts : [blankContract()]);
  const set = (index: number, patch: Partial<ContractDraft>) => {
    save.reset();
    setDraft((current) => current.map((contract, i) => (i === index ? { ...contract, ...patch } : contract)));
  };
  return (
    <BlockForm
      onSubmit={() =>
        save.mutate(
          { contracts: draft.filter((contract) => contract.service.trim() || contract.id) },
          // New contracts come back with their ids: the next save updates them.
          { onSuccess: (next) => setDraft(next.contracts.length ? next.contracts : [blankContract()]) },
        )
      }
      pending={save.isPending}
      error={save.error}
      saved={save.isSuccess}
      canEdit={record.access.canEdit}
    >
      {draft.map((contract, index) => (
        <fieldset key={contract.id ?? `new-${index}`} className="block">
          <legend>{draft.length > 1 ? `Contrato ${index + 1}` : 'Contrato'}</legend>
          <div className="grid-3">
            <TextField label="Serviço contratado" value={contract.service} onChange={(service) => set(index, { service: service ?? '' })} placeholder="Formatação de franquia" />
            <TextField label="Nº do contrato" value={contract.number} onChange={(number) => set(index, { number })} />
            <TextField label="Data do contrato" type="date" value={contract.signedOn} onChange={(signedOn) => set(index, { signedOn })} />
            <MoneyField label="Valor" value={contract.valueCents} onChange={(valueCents) => set(index, { valueCents })} />
            <TextField label="Forma de pagamento" value={contract.paymentMethod} onChange={(paymentMethod) => set(index, { paymentMethod })} placeholder="Boleto, Pix, cartão…" />
            <IntegerField label="Parcelas" value={contract.installments} onChange={(installments) => set(index, { installments })} />
            <TextField label="Início" type="date" value={contract.startsOn} onChange={(startsOn) => set(index, { startsOn })} />
            <IntegerField label="Prazo (meses)" value={contract.termMonths} onChange={(termMonths) => set(index, { termMonths })} />
            <Field label="Origem do lead (CRM)" hint={record.leadOptions === null ? 'A lista de leads é de quem lê o funil inteiro.' : undefined}>
              {record.leadOptions === null ? (
                <Input value={contract.leadId ? 'Lead vinculado' : 'Nenhum'} disabled readOnly />
              ) : (
                <Select value={contract.leadId ?? ''} onChange={(event) => set(index, { leadId: event.target.value || null })}>
                  <option value="">Nenhum</option>
                  {record.leadOptions.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {lead.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <h3 className="record-subhead">Consultor por área</h3>
          <div className="grid-3">
            {CONSULTANT_AREAS.map((area: ConsultantArea) => {
              const options = record.consultantOptions[area] ?? [];
              const current = contract.consultants[area];
              return (
                <Field key={area} label={SECTORS[area].name}>
                  <Select
                    value={current ?? ''}
                    onChange={(event) => {
                      const consultants = { ...contract.consultants };
                      if (event.target.value) consultants[area] = event.target.value;
                      else delete consultants[area];
                      set(index, { consultants });
                    }}
                  >
                    <option value="">—</option>
                    {current && !options.some((option) => option.id === current) && (
                      <option value={current}>(funcionário inativo)</option>
                    )}
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            })}
          </div>
          {record.access.canEdit && draft.length > 1 && (
            <Button type="button" variant="ghost" onClick={() => setDraft((all) => all.filter((_, i) => i !== index))}>
              Remover este contrato
            </Button>
          )}
        </fieldset>
      ))}
      {record.access.canEdit && (
        <Button type="button" variant="ghost" onClick={() => setDraft((all) => [...all, blankContract()])}>
          Adicionar outro contrato
        </Button>
      )}
    </BlockForm>
  );
}

// --- 6. Franquia planejada ------------------------------------------------------------------

function FranchiseBlock({ record }: { record: ClientRecord }) {
  const save = useSaveClientBlock<ClientFranchise>(record.client.id, 'franchise');
  const [draft, setDraft] = useState<ClientFranchise>(record.franchise);
  const set = (patch: Partial<ClientFranchise>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setUnit = (index: number, patch: Partial<ClientUnitModel>) =>
    set({ unitModels: draft.unitModels.map((unit, i) => (i === index ? { ...unit, ...patch } : unit)) });
  return (
    <BlockForm onSubmit={() => save.mutate(draft)} pending={save.isPending} error={save.error} saved={save.isSuccess} canEdit={record.access.canEdit}>
      <p className="muted">Estes dados alimentam a Circular de Oferta de Franquia (Lei 13.966/2019).</p>
      <div className="grid-3">
        <MoneyField label="Taxa de franquia" value={draft.franchiseFeeCents} onChange={(franchiseFeeCents) => set({ franchiseFeeCents })} />
        <PercentField label="Royalties" value={draft.royaltiesPercent} onChange={(royaltiesPercent) => set({ royaltiesPercent })} hint="Sobre o faturamento bruto." />
        <PercentField label="Fundo de propaganda" value={draft.adFundPercent} onChange={(adFundPercent) => set({ adFundPercent })} />
        <MoneyField label="Investimento inicial" value={draft.initialInvestmentCents} onChange={(initialInvestmentCents) => set({ initialInvestmentCents })} hint="Total estimado, com a taxa." />
      </div>
      <TextField label="Perfil do franqueado" multiline value={draft.franchiseeProfile} onChange={(franchiseeProfile) => set({ franchiseeProfile })} />
      <Field label="Área de expansão" hint="Editada na lista de clientes, em “Links e expansão”.">
        <Input
          value={record.client.expansionArea.map(formatExpansionEntry).join(', ') || 'Não definida'}
          disabled
          readOnly
        />
      </Field>

      <h3 className="record-subhead">Modelos de unidade</h3>
      {draft.unitModels.map((unit, index) => (
        <fieldset key={index} className="block">
          <legend>{unit.name || `Modelo ${index + 1}`}</legend>
          <div className="grid-3">
            <TextField label="Nome do modelo" value={unit.name} onChange={(name) => setUnit(index, { name: name ?? '' })} placeholder="Loja, quiosque, delivery…" />
            <IntegerField label="Área (m²)" value={unit.areaM2} onChange={(areaM2) => setUnit(index, { areaM2 })} />
            <MoneyField label="Investimento inicial" value={unit.initialInvestmentCents} onChange={(initialInvestmentCents) => setUnit(index, { initialInvestmentCents })} />
            <MoneyField label="Taxa de franquia" value={unit.franchiseFeeCents} onChange={(franchiseFeeCents) => setUnit(index, { franchiseFeeCents })} />
          </div>
          <TextField label="Descrição" multiline value={unit.description} onChange={(description) => setUnit(index, { description })} />
          {record.access.canEdit && (
            <Button type="button" variant="ghost" onClick={() => set({ unitModels: draft.unitModels.filter((_, i) => i !== index) })}>
              Remover modelo
            </Button>
          )}
        </fieldset>
      ))}
      {record.access.canEdit && (
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            set({
              unitModels: [
                ...draft.unitModels,
                { name: '', description: null, initialInvestmentCents: null, franchiseFeeCents: null, areaM2: null },
              ],
            })
          }
        >
          Adicionar modelo de unidade
        </Button>
      )}
    </BlockForm>
  );
}

// --- 7. Assinatura ---------------------------------------------------------------------------

interface WitnessDraft {
  id?: string;
  name: string;
  cpf: string;
  email: string | null;
  cpfMasked: string | null;
  cpfOnFile: boolean;
}

function WitnessCpf({ record, witness, onChange }: { record: ClientRecord; witness: WitnessDraft; onChange: (cpf: string) => void }) {
  const reveal = useRevealClientCpf(record.client.id);
  if (!record.access.canSeeSensitive) {
    return (
      <Field label="CPF" hint="Restrito ao Jurídico, Diretoria e Admin Master.">
        <Input value={witness.cpfOnFile ? 'Informado' : 'Não informado'} disabled readOnly />
      </Field>
    );
  }
  return (
    <Field label="CPF" hint={witness.cpfOnFile ? 'Preencha só para trocar o CPF.' : undefined}>
      <div className="input-row">
        <Input value={witness.cpf} placeholder={witness.cpfMasked ?? '000.000.000-00'} inputMode="numeric" onChange={(event) => onChange(event.target.value)} />
        {witness.id && witness.cpfOnFile && (
          <Button type="button" variant="ghost" disabled={reveal.isPending} onClick={() => reveal.mutate({ kind: 'witness', id: witness.id as string })}>
            {reveal.isPending ? '…' : 'Revelar'}
          </Button>
        )}
      </div>
      {reveal.data && (
        <span className="field-hint reveal">
          CPF completo: <strong className="mono">{formatCpf(reveal.data.cpf)}</strong> — registrado no log de auditoria.
        </span>
      )}
    </Field>
  );
}

function SignatureBlock({ record }: { record: ClientRecord }) {
  const save = useSaveClientBlock<unknown>(record.client.id, 'signature');
  const s = record.signature;
  const [draft, setDraft] = useState({
    signerPartnerId: s.signerPartnerId,
    signingEmail: s.signingEmail,
    signingMobile: s.signingMobile,
    signatureType: s.signatureType,
    forum: s.forum,
  });
  const [witnesses, setWitnesses] = useState<WitnessDraft[]>(s.witnesses.map((w) => ({ ...w, cpf: '' })));
  const set = (patch: Partial<typeof draft>) => {
    save.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setWitness = (index: number, patch: Partial<WitnessDraft>) => {
    save.reset();
    setWitnesses((all) => all.map((w, i) => (i === index ? { ...w, ...patch } : w)));
  };
  const signer = record.partners.find((partner) => partner.id === draft.signerPartnerId);

  return (
    <BlockForm
      onSubmit={() =>
        save.mutate(
          {
            ...draft,
            witnesses: witnesses
              .filter((w) => w.name.trim())
              .map((w) => ({
                ...(w.id ? { id: w.id } : {}),
                name: w.name,
                email: w.email,
                ...(record.access.canSeeSensitive && w.cpf.trim() ? { cpf: w.cpf } : {}),
              })),
          },
          {
            onSuccess: (next) => setWitnesses(next.signature.witnesses.map((w) => ({ ...w, cpf: '' }))),
          },
        )
      }
      pending={save.isPending}
      error={save.error}
      saved={save.isSuccess}
      canEdit={record.access.canEdit}
    >
      <p className="muted">
        O envio para assinatura digital chega com o Documenso. Aqui fica quem assina, como e onde.
      </p>
      <div className="grid-3">
        <Field label="Quem assina pela empresa" hint={record.partners.length === 0 ? 'Cadastre os sócios primeiro.' : undefined}>
          <Select value={draft.signerPartnerId ?? ''} onChange={(event) => set({ signerPartnerId: event.target.value || null })}>
            <option value="">—</option>
            {record.partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
                {partner.signsForCompany ? ' (assina pela empresa)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <TextField
          label="E-mail de assinatura"
          type="email"
          value={draft.signingEmail}
          onChange={(signingEmail) => set({ signingEmail })}
          hint={signer?.email && !draft.signingEmail ? `O do sócio: ${signer.email}` : undefined}
        />
        <TextField label="Celular de assinatura" type="tel" value={draft.signingMobile} onChange={(signingMobile) => set({ signingMobile })} />
        <ChoiceField<SignatureType> label="Tipo de assinatura" value={draft.signatureType} onChange={(signatureType) => set({ signatureType })} options={SIGNATURE_TYPES} labels={SIGNATURE_TYPE_LABELS} />
        <TextField label="Foro" value={draft.forum} onChange={(forum) => set({ forum })} placeholder="Comarca de São Paulo/SP" />
      </div>

      <h3 className="record-subhead">Testemunhas</h3>
      {witnesses.map((witness, index) => (
        <div key={witness.id ?? `new-${index}`} className="grid-3">
          <TextField label={`Testemunha ${index + 1}`} value={witness.name} onChange={(name) => setWitness(index, { name: name ?? '' })} />
          <WitnessCpf record={record} witness={witness} onChange={(cpf) => setWitness(index, { cpf })} />
          <TextField label="E-mail" type="email" value={witness.email} onChange={(email) => setWitness(index, { email })} />
          {record.access.canEdit && (
            <div className="record-actions">
              <Button type="button" variant="ghost" onClick={() => setWitnesses((all) => all.filter((_, i) => i !== index))}>
                Remover testemunha
              </Button>
            </div>
          )}
        </div>
      ))}
      {record.access.canEdit && witnesses.length < CLIENT_MAX_WITNESSES && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setWitnesses((all) => [...all, { name: '', cpf: '', email: null, cpfMasked: null, cpfOnFile: false }])}
        >
          Adicionar testemunha
        </Button>
      )}
    </BlockForm>
  );
}

// --- the page ------------------------------------------------------------------------------------

export function ClientRecordPage() {
  const { id = '' } = useParams<{ id: string }>();
  const query = useClientRecord(id);
  const [tab, setTab] = useState<ClientRecordBlock>('empresa');
  const [addingPartner, setAddingPartner] = useState<string | null>(null);
  const record = query.data;

  if (query.isLoading) return <div className="page-loading">Carregando…</div>;
  if (!record) {
    return (
      <>
        <header className="page-header">
          <h1>Ficha do cliente</h1>
        </header>
        <Alert kind="error">{errorText(query.error, 'Não foi possível abrir a ficha.')}</Alert>
        <p>
          <Link to="/formatacao/clientes">Voltar à lista</Link>
        </p>
      </>
    );
  }

  const { percent } = record.completeness;
  const number = record.client.number === null ? '' : `${String(record.client.number).padStart(2, '0')}. `;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>
            {number}
            {record.client.name}
          </h1>
          <p>
            Ficha completa: os dados que o Jurídico usa nos contratos e na COF.
            {!record.client.active && ' Cliente inativo.'}
          </p>
        </div>
        <div className="record-header-actions">
          {record.documentsFolderId && (
            <Link className="btn btn-ghost btn-inline" to={`/drive/arquivos?pasta=${record.documentsFolderId}`}>
              Documentos Enviados
            </Link>
          )}
          <Link to="/formatacao/clientes" className="btn btn-ghost btn-inline">
            Voltar
          </Link>
        </div>
      </header>

      <section className="record-progress" aria-label="Preenchimento da ficha">
        <div className="record-progress-head">
          <strong>{percent}% preenchido</strong>
          <span className="muted">Contrato social, cartão CNPJ e documentos dos sócios vão em Documentos Enviados, no Drive.</span>
        </div>
        <div
          className="record-progress-bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${percent}% preenchido`}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      </section>

      {!record.access.canEdit && <Alert kind="info">Você pode consultar esta ficha, mas não editá-la.</Alert>}

      <div className="tab-row record-tabs" role="tablist">
        {CLIENT_RECORD_BLOCKS.map((block) => {
          const entry = record.completeness.blocks.find((item) => item.block === block);
          return (
            <button
              key={block}
              type="button"
              role="tab"
              aria-selected={tab === block}
              className={`tab-button ${tab === block ? 'tab-button-active' : ''}`}
              onClick={() => setTab(block)}
            >
              {CLIENT_RECORD_BLOCK_LABELS[block]}
              {entry && (
                <span className={`record-tab-count ${entry.filled === entry.total ? 'record-tab-done' : ''}`}>
                  {entry.filled}/{entry.total}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        <Missing record={record} block={tab} />
        {tab === 'empresa' && (
          <CompanyBlock
           
            record={record}
            onPartnerSuggestion={(name) => {
              setAddingPartner(name);
              setTab('socios');
            }}
          />
        )}
        {tab === 'socios' && <PartnersBlock record={record} adding={addingPartner} setAdding={setAddingPartner} />}
        {tab === 'contatos' && <ContactsBlock record={record} />}
        {tab === 'negocio' && <BusinessBlock record={record} />}
        {tab === 'contrato' && <ContractsBlock record={record} />}
        {tab === 'franquia' && <FranchiseBlock record={record} />}
        {tab === 'assinatura' && <SignatureBlock record={record} />}
      </div>
    </>
  );
}
