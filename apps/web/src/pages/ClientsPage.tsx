import {
  CLIENT_NAME_MAX,
  CLIENT_NUMBER_MAX,
  CLIENT_RELATIONSHIPS,
  CLIENT_RELATIONSHIP_LABELS,
  FIT_LEVELS,
  FIT_LEVEL_LABELS,
  REVENUE_BANDS,
  REVENUE_BAND_LABELS,
  LEAD_LINK_CHANNELS,
  LEAD_CHANNEL_LABELS,
  PROJECT_STATUS_LABELS,
  WINGS_CLIENT_ID,
  formatCnpj,
  formatExpansionEntry,
  isValidCnpj,
  type Client,
  type ClientRelationship,
  type FitLevel,
  type RevenueBand,
  type LeadLinkChannel,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useClients, useCnpjLookup, useCreateClient, useUpdateClient } from '../api/clients.js';
import { useProjects } from '../api/projects.js';
import { useCreateTrackingLink, useTrackingLinks, useUpdateExpansionArea } from '../api/leads.js';
import { ProjectStatusTag, StatusDialog, stageLabel } from '../components/projects/ProjectParts.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';
import type { ClientProject } from '@wings/shared';
import { PageHeader } from '../components/PageHeader.js';
import { WhatsAppArtPanel } from '../components/WhatsAppArtPanel.js';

/**
 * Formatação → Clientes. The register of who work is for: a quick
 * registration (name, and the CNPJ and main contact when known) and, per
 * client, the full record ("ficha", ClientRecordPage). Wings Company is the
 * fixed first row. Since the Funil (part 1), a client also carries its
 * expansion area and its tracked WhatsApp links, and the page keeps the rules
 * that map a landing page or a Meta form to a client.
 *
 * Registering, renaming and deactivating are `clients.manage`; Jurídico only
 * reads the list and fills the record.
 */

function ExpansionArea({ client }: { client: Client }) {
  const update = useUpdateExpansionArea();
  const [text, setText] = useState(client.expansionArea.map(formatExpansionEntry).join(', '));
  return (
    <form
      className="lead-area"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({
          clientId: client.id,
          expansionArea: text
            .split(/[,;\n]/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        });
      }}
    >
      <Field
        label="Área de expansão"
        hint="Estados ou cidades, separados por vírgula: SP, Campinas/SP, Belém/PA. A pesquisa do lead compara a região do DDD com esta lista."
      >
        <Input
          aria-label={`Área de expansão de ${client.name}`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            update.reset();
          }}
        />
      </Field>
      {update.error && (
        <div className="field-error" role="alert">
          {update.error instanceof ApiError
            ? update.error.message
            : 'Não foi possível salvar a área.'}
        </div>
      )}
      {update.isSuccess && <div className="field-hint">Área salva.</div>}
      <Button type="submit" variant="ghost" disabled={update.isPending}>
        Salvar área
      </Button>
    </form>
  );
}

function TrackingLinks({ client }: { client: Client }) {
  const links = useTrackingLinks(client.id);
  const create = useCreateTrackingLink();
  const [channel, setChannel] = useState<LeadLinkChannel>('instagram');
  const [copied, setCopied] = useState<string | null>(null);
  const list = links.data?.links ?? [];

  return (
    <div className="lead-links-admin">
      <h3 className="lead-subhead">Links rastreáveis do WhatsApp</h3>
      <p className="muted">
        Cada link abre o WhatsApp da Wings (onde a Sofia atende) com um código e o nome da marca já
        escritos. Quem manda a mensagem é etiquetado com este cliente e o canal do link. O WhatsApp
        próprio da marca fica só na ficha, como contato.
      </p>
      {links.data && !links.data.phoneConfigured && (
        <Alert kind="warning">
          O número de WhatsApp da Wings (WINGS_WHATSAPP_NUMBER) não está configurado neste ambiente.
        </Alert>
      )}
      <form
        className="clients-rename"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ clientId: client.id, channel });
        }}
      >
        <Select
          aria-label={`Canal do novo link de ${client.name}`}
          value={channel}
          onChange={(event) => setChannel(event.target.value as LeadLinkChannel)}
        >
          {LEAD_LINK_CHANNELS.map((item) => (
            <option key={item} value={item}>
              {LEAD_CHANNEL_LABELS[item]}
            </option>
          ))}
        </Select>
        <Button
          type="submit"
          variant="ghost"
          disabled={create.isPending || links.data?.phoneConfigured === false}
        >
          Gerar link
        </Button>
      </form>
      {create.error && (
        <div className="field-error" role="alert">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível gerar o link.'}
        </div>
      )}
      {links.isError && (
        <LoadFailure what="os links" error={links.error} onRetry={() => void links.refetch()} />
      )}
      {list.length > 0 && (
        <table className="table lead-links-table">
          <thead>
            <tr>
              <th>Canal</th>
              <th>Link</th>
              <th>Mensagens</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((link) => (
              <tr key={link.id}>
                <td>{LEAD_CHANNEL_LABELS[link.channel]}</td>
                <td className="mono lead-wrap">
                  {link.url}
                  {!link.current && (
                    <div className="field-error">
                      Abre um número que não é mais o WhatsApp da Wings. Gere um link novo.
                    </div>
                  )}
                </td>
                <td>{link.hits}</td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(link.url).then(() => setCopied(link.id));
                    }}
                  >
                    {copied === link.id ? 'Copiado' : 'Copiar'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** `NN` as the Drive shows it: `Clientes/07. Nome`. */
const numberLabel = (number: number | null) =>
  number === null ? '—' : String(number).padStart(2, '0');

function ClientRow({
  client,
  project,
  open,
  onToggle,
  onStatus,
  canManage,
  projectUnavailable,
}: {
  canManage: boolean;
  client: Client;
  project: ClientProject | undefined;
  /** The projects could not be loaded: a blank cell would read as "no project". */
  projectUnavailable: boolean;
  open: boolean;
  onToggle: () => void;
  onStatus: (project: ClientProject) => void;
}) {
  const update = useUpdateClient();
  const [name, setName] = useState(client.name);
  const [number, setNumber] = useState(client.number === null ? '' : String(client.number));
  const [editing, setEditing] = useState(false);
  const fixed = client.id === WINGS_CLIENT_ID;

  return (
    <>
      <tr>
        <td className="mono">{editing ? null : numberLabel(client.number)}</td>
        <td>
          {editing ? (
            <form
              className="clients-rename"
              onSubmit={(event) => {
                event.preventDefault();
                const next = Number(number);
                update.mutate(
                  {
                    id: client.id,
                    ...(name !== client.name ? { name } : {}),
                    ...(Number.isInteger(next) && next !== client.number ? { number: next } : {}),
                  },
                  { onSuccess: () => setEditing(false) },
                );
              }}
            >
              <input
                className="control clients-number"
                aria-label={`Número de ${client.name}`}
                type="number"
                min={1}
                max={CLIENT_NUMBER_MAX}
                value={number}
                onChange={(event) => setNumber(event.target.value)}
              />
              <input
                className="control"
                aria-label={`Novo nome de ${client.name}`}
                value={name}
                maxLength={CLIENT_NAME_MAX}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" variant="ghost" disabled={update.isPending}>
                Salvar
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setName(client.name);
                  setNumber(client.number === null ? '' : String(client.number));
                  setEditing(false);
                  update.reset();
                }}
              >
                Cancelar
              </Button>
            </form>
          ) : (
            <>
              {client.name}
              {fixed && <span className="tag">padrão</span>}
              {client.relationship && (
                <span className="cell-sub">
                  {' '}
                  · {CLIENT_RELATIONSHIP_LABELS[client.relationship]}
                </span>
              )}
              {client.franchiseOnSale != null && (
                <span className="cell-sub">
                  {' '}
                  · {client.franchiseOnSale ? 'Em comercialização' : 'Fora de comercialização'}
                </span>
              )}
              {!fixed &&
                (client.relationship === 'expansao' || client.relationship === 'ambos') &&
                (!client.whatsappArt || !client.article) && (
                  <div className="cell-sub">
                    <span
                      className="tag"
                      title="Cadastre na ficha da marca: vai no cabeçalho dos modelos de WhatsApp"
                    >
                      WhatsApp: falta{' '}
                      {[!client.whatsappArt && 'a arte', !client.article && 'o artigo (o/a)']
                        .filter(Boolean)
                        .join(' e ')}
                    </span>
                  </div>
                )}
              {!fixed && (client.registerMissing?.length ?? 0) > 0 && (
                <div className="cell-sub">
                  <span className="tag" title={`Falta: ${client.registerMissing!.join(', ')}`}>
                    Cadastro incompleto
                  </span>{' '}
                  Falta: {client.registerMissing!.join(', ')}.
                </div>
              )}
              {client.expansionArea.length > 0 && (
                <div className="cell-sub">
                  Expansão: {client.expansionArea.map(formatExpansionEntry).join(', ')}
                </div>
              )}
            </>
          )}
          {update.error && (
            <div className="field-error" role="alert">
              {update.error instanceof ApiError ? update.error.message : 'Não foi possível salvar.'}
            </div>
          )}
        </td>
        <td>
          <span className={`status status-${client.active ? 'active' : 'inactive'}`}>
            {client.active ? 'Ativo' : 'Inativo'}
          </span>
        </td>
        <td>
          {!project && projectUnavailable && (
            <span className="unavailable" title="Não foi possível carregar os projetos">
              —
            </span>
          )}
          {project && (
            <div className="clients-project">
              {project.canManage ? (
                <button
                  type="button"
                  className="projects-status-button"
                  aria-label={`Status do projeto de ${client.name}: ${PROJECT_STATUS_LABELS[project.status]}`}
                  onClick={() => onStatus(project)}
                >
                  <ProjectStatusTag status={project.status} />
                </button>
              ) : (
                <ProjectStatusTag status={project.status} />
              )}
              <div className="cell-sub">Etapa atual: {stageLabel(project.currentStage)}</div>
            </div>
          )}
        </td>
        <td>
          <div className="clients-actions">
            {!fixed && !editing && (
              <Link className="btn btn-ghost" to={`/formatacao/clientes/${client.id}`}>
                Ficha
              </Link>
            )}
            {canManage && !fixed && !editing && (
              <>
                <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
                  Editar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: client.id, active: !client.active })}
                >
                  {client.active ? 'Desativar' : 'Reativar'}
                </Button>
              </>
            )}
            {canManage && !fixed && client.active && (
              <Button type="button" variant="ghost" aria-expanded={open} onClick={onToggle}>
                {open ? 'Fechar' : 'Links e expansão'}
              </Button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="lead-client-details">
            <ExpansionArea client={client} />
            <TrackingLinks client={client} />
          </td>
        </tr>
      )}
    </>
  );
}

/** "Cadastro rápido": the name, and the CNPJ and main contact when already known. */
const TODAY = () => new Date().toISOString().slice(0, 10);

/**
 * "Novo cliente", the new register (Eric, 30/09): the CNPJ looks the company
 * up in the Receita (BrasilAPI) and fills it; the main contact with e-mail
 * and WhatsApp, the relationship with Wings and the franchise profile are
 * required. Nothing is guessed: what the Receita does not say stays for a
 * person to fill.
 */
function QuickCreate() {
  const create = useCreateClient();
  const lookup = useCnpjLookup();
  const empty = {
    name: '',
    cnpj: '',
    legalName: '',
    tradeName: '',
    cnaeMain: '',
    openedOn: '',
    city: '',
    state: '',
    contactName: '',
    email: '',
    whatsapp: '',
    relationship: '' as ClientRelationship | '',
    segment: '',
    ownUnits: '',
    revenueBand: '' as RevenueBand | 'nao_informado' | '',
    franchisability: '' as FitLevel | '',
    wingsFit: '' as FitLevel | '',
    profileSource: '',
    profileDate: TODAY(),
  };
  const [form, setForm] = useState(empty);
  const set = (key: keyof typeof empty) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
    create.reset();
  };
  const cnpjDigits = form.cnpj.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const cnpjOk = cnpjDigits.length === 14 && isValidCnpj(cnpjDigits);
  const ready =
    cnpjOk &&
    form.name.trim().length >= 2 &&
    form.legalName.trim().length >= 2 &&
    form.contactName.trim().length >= 2 &&
    form.email.trim() !== '' &&
    form.whatsapp.trim() !== '' &&
    form.relationship !== '' &&
    form.segment.trim().length >= 2 &&
    form.ownUnits !== '' &&
    form.revenueBand !== '' &&
    form.franchisability !== '' &&
    form.wingsFit !== '' &&
    form.profileSource.trim().length >= 2 &&
    form.profileDate !== '';

  return (
    <section className="block clients-quick" id="novo">
      <h2>Novo cliente</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name: form.name,
              cnpj: cnpjDigits,
              company: {
                legalName: form.legalName,
                tradeName: form.tradeName || null,
                cnaeMain: form.cnaeMain || null,
                openedOn: form.openedOn || null,
                city: form.city || null,
                state: form.state || null,
              },
              contact: { name: form.contactName, email: form.email, whatsapp: form.whatsapp },
              relationship: form.relationship as ClientRelationship,
              business: {
                segment: form.segment,
                ownUnits: Number(form.ownUnits),
                revenueBand:
                  form.revenueBand === 'nao_informado' ? null : (form.revenueBand as RevenueBand),
                franchisability: form.franchisability as FitLevel,
                wingsFit: form.wingsFit as FitLevel,
                profileSource: form.profileSource,
                profileDate: form.profileDate,
              },
            },
            {
              onSuccess: () => {
                setForm({ ...empty, profileDate: TODAY() });
                lookup.reset();
              },
            },
          );
        }}
      >
        <div className="grid-3">
          <Field
            label="CNPJ"
            required
            hint={
              lookup.data
                ? `Receita (${lookup.data.source}): ${lookup.data.registrationStatus ?? 'situação não informada'}`
                : 'Buscar preenche os dados da Receita.'
            }
            error={
              lookup.error
                ? lookup.error instanceof ApiError
                  ? lookup.error.message
                  : 'Não foi possível consultar o CNPJ.'
                : cnpjDigits === '' || cnpjOk
                  ? undefined
                  : 'CNPJ inválido'
            }
          >
            <div className="input-row">
              <Input
                value={cnpjDigits.length === 14 ? formatCnpj(cnpjDigits) : form.cnpj}
                placeholder="00.000.000/0000-00"
                onChange={(event) => {
                  set('cnpj')(event);
                  lookup.reset();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                disabled={!cnpjOk || lookup.isPending}
                onClick={() =>
                  lookup.mutate(cnpjDigits, {
                    onSuccess: (found) => {
                      const company = found.company;
                      const cnae = company.cnaeMain ?? '';
                      setForm((current) => ({
                        ...current,
                        name:
                          current.name ||
                          (company.tradeName ?? company.legalName ?? '').slice(0, CLIENT_NAME_MAX),
                        legalName: company.legalName ?? current.legalName,
                        tradeName: company.tradeName ?? current.tradeName,
                        cnaeMain: cnae || current.cnaeMain,
                        openedOn: company.openedOn ?? current.openedOn,
                        city: company.address?.city ?? current.city,
                        state: company.address?.state ?? current.state,
                        segment: current.segment || cnae.split(' - ').slice(1).join(' - '),
                      }));
                    },
                  })
                }
              >
                {lookup.isPending ? 'Buscando…' : 'Buscar'}
              </Button>
            </div>
          </Field>
          <Field label="Nome do cliente" required>
            <Input
              value={form.name}
              maxLength={CLIENT_NAME_MAX}
              placeholder="Como a Wings chama o cliente"
              onChange={set('name')}
            />
          </Field>
          <Field label="Relação com a Wings" required>
            <Select value={form.relationship} onChange={set('relationship')}>
              <option value="">Escolha</option>
              {CLIENT_RELATIONSHIPS.map((item) => (
                <option key={item} value={item}>
                  {CLIENT_RELATIONSHIP_LABELS[item]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Razão social" required>
            <Input value={form.legalName} onChange={set('legalName')} />
          </Field>
          <Field label="Nome fantasia">
            <Input value={form.tradeName} onChange={set('tradeName')} />
          </Field>
          <Field label="CNAE principal">
            <Input value={form.cnaeMain} onChange={set('cnaeMain')} />
          </Field>
          <Field label="Data de abertura">
            <Input type="date" value={form.openedOn} onChange={set('openedOn')} />
          </Field>
          <Field label="Cidade">
            <Input value={form.city} onChange={set('city')} />
          </Field>
          <Field label="UF">
            <Input value={form.state} maxLength={2} onChange={set('state')} />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Contato principal" required>
            <Input value={form.contactName} placeholder="Nome" onChange={set('contactName')} />
          </Field>
          <Field label="E-mail do contato" required>
            <Input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="WhatsApp do contato" required>
            <Input
              type="tel"
              value={form.whatsapp}
              placeholder="(11) 99999-9999"
              onChange={set('whatsapp')}
            />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Segmento" required>
            <Input value={form.segment} onChange={set('segment')} />
          </Field>
          <Field label="Unidades" required>
            <Input type="number" min={0} value={form.ownUnits} onChange={set('ownUnits')} />
          </Field>
          <Field label="Faixa de faturamento" required>
            <Select value={form.revenueBand} onChange={set('revenueBand')}>
              <option value="">Escolha</option>
              {REVENUE_BANDS.map((band) => (
                <option key={band} value={band}>
                  {REVENUE_BAND_LABELS[band]}
                </option>
              ))}
              <option value="nao_informado">Não informado pelo cliente</option>
            </Select>
          </Field>
          <Field label="Franqueabilidade" required>
            <Select value={form.franchisability} onChange={set('franchisability')}>
              <option value="">Escolha</option>
              {FIT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {FIT_LEVEL_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fit Wings" required>
            <Select value={form.wingsFit} onChange={set('wingsFit')}>
              <option value="">Escolha</option>
              {FIT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {FIT_LEVEL_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Fonte do dado"
            required
            hint="De onde veio o perfil: reunião, site da marca, planilha do cliente…"
          >
            <Input value={form.profileSource} onChange={set('profileSource')} />
          </Field>
          <Field label="Data do dado" required>
            <Input type="date" value={form.profileDate} onChange={set('profileDate')} />
          </Field>
        </div>
        <Button type="submit" className="btn-inline" disabled={create.isPending || !ready}>
          Cadastrar cliente
        </Button>
        <span className="field-hint clients-quick-hint">
          Sócios, contrato e franquia vão na ficha do cliente.
        </span>
      </form>
      {create.error && (
        <Alert kind="error">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível cadastrar o cliente.'}
        </Alert>
      )}
    </section>
  );
}

export function ClientsPage() {
  const clients = useClients();
  const { data: user } = useSession();
  const canManage = hasPermission(user, 'clients.manage');
  // Every client's project, inactive ones included: this is the register of all of them.
  const projects = useProjects({ inactive: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusOf, setStatusOf] = useState<ClientProject | null>(null);
  const list = clients.data?.clients ?? [];
  const projectByClient = new Map(
    (projects.data?.projects ?? []).map((project) => [project.clientId, project]),
  );

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Para quem o trabalho é feito: cada cliente tem um número e uma pasta no Drive, criada no cadastro."
      />

      {canManage && <QuickCreate />}
      {canManage && (
        <WhatsAppArtPanel clientId={WINGS_CLIENT_ID} name="Wings Company" canEdit wings />
      )}
      {clients.isError && (
        <LoadFailure
          what="os clientes"
          error={clients.error}
          onRetry={() => void clients.refetch()}
        />
      )}
      {projects.isError && (
        <LoadFailure
          what="os projetos dos clientes"
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th title="O número da pasta do cliente no Drive: Clientes/NN. Nome">Nº</th>
              <th>Nome</th>
              <th>Situação</th>
              <th title="Status e etapa atual do projeto; o quadro fica em Gestão → Projetos">
                Projeto
              </th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.isLoading && (
              <tr>
                <td colSpan={5} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {list.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                project={projectByClient.get(client.id)}
                projectUnavailable={projects.isError && !projects.data}
                open={openId === client.id}
                onToggle={() => setOpenId((current) => (current === client.id ? null : client.id))}
                onStatus={setStatusOf}
                canManage={canManage}
              />
            ))}
          </tbody>
        </table>
      </div>

      {statusOf && <StatusDialog project={statusOf} onClose={() => setStatusOf(null)} />}
    </>
  );
}
