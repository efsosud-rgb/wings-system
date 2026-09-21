import { CLIENT_NAME_MAX, WINGS_CLIENT_ID, type Client } from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useClients, useCreateClient, useUpdateClient } from '../api/clients.js';
import { Alert, Button } from '../components/ui.js';

/**
 * Administração → Clientes. The smallest register that lets work be filed
 * under who it is for: a name, and whether the client is still active. Wings
 * Company is the fixed first row.
 */

function ClientRow({ client }: { client: Client }) {
  const update = useUpdateClient();
  const [name, setName] = useState(client.name);
  const [editing, setEditing] = useState(false);
  const fixed = client.id === WINGS_CLIENT_ID;

  return (
    <tr>
      <td>
        {editing ? (
          <form
            className="clients-rename"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate({ id: client.id, name }, { onSuccess: () => setEditing(false) });
            }}
          >
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
        {!fixed && !editing && (
          <div className="clients-actions">
            <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
              Renomear
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: client.id, active: !client.active })}
            >
              {client.active ? 'Desativar' : 'Reativar'}
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

export function ClientsPage() {
  const clients = useClients();
  const create = useCreateClient();
  const [name, setName] = useState('');
  const list = clients.data?.clients ?? [];

  return (
    <>
      <header className="page-header">
        <h1>Clientes</h1>
        <p>
          Para quem o trabalho é feito. A mídia gerada é arquivada pelo cliente escolhido; o nome do
          cliente não é enviado a fornecedores.
        </p>
      </header>

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(name, { onSuccess: () => setName('') });
        }}
      >
        <label className="field">
          <span className="field-label">Novo cliente</span>
          <input
            className="control"
            value={name}
            maxLength={CLIENT_NAME_MAX}
            placeholder="Nome do cliente"
            onChange={(event) => {
              setName(event.target.value);
              create.reset();
            }}
          />
        </label>
        <Button type="submit" disabled={create.isPending || name.trim().length < 2}>
          Cadastrar cliente
        </Button>
      </form>
      {create.error && (
        <Alert kind="error">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível cadastrar o cliente.'}
        </Alert>
      )}
      {clients.isError && <Alert kind="error">Não foi possível carregar os clientes.</Alert>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Situação</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.isLoading && (
              <tr>
                <td colSpan={3} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {list.map((client) => (
              <ClientRow key={client.id} client={client} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
