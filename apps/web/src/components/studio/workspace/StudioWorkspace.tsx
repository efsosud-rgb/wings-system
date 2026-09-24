import {
  STUDIO_BROWSER_EXPORT_MAX_SECONDS,
  STUDIO_PROJECT_SUFFIX,
  STUDIO_SHORTCUTS,
  type StudioAspect,
} from '@wings/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Dialog } from '../../drive/DriveParts.js';
import { Alert, Button } from '../../ui.js';
import { DriveFilePicker } from '../DriveFilePicker.js';
import { PropertiesPanel } from '../PropertiesPanel.js';
import { SaveToDriveDialog } from '../SaveToDriveDialog.js';
import type { StudioMode, StudioSession } from '../session.js';
import { useStudioSession } from '../useStudioSession.js';
import { useStudioShortcuts } from '../useStudioShortcuts.js';
import { AgentDrawer } from './AgentDrawer.js';
import { BottomDock } from './BottomDock.js';
import { AudioPanel } from './panels/AudioPanel.js';
import { ElementsPanel } from './panels/ElementsPanel.js';
import { GeneratePanel } from './panels/GeneratePanel.js';
import { LibraryPanel } from './panels/LibraryPanel.js';
import { TextPanel } from './panels/TextPanel.js';
import { Rail, RailPanelFrame, type RailPanel } from './Rail.js';
import { Stage } from './Stage.js';
import { TopBar, type TopBarDialog } from './TopBar.js';

/**
 * The studio as one room: rail and panels on the left, the stage in the
 * middle, properties and the agent on the right, the timeline or the layers
 * below. Every action goes through the session, which owns the core and the
 * rule that a project never carries an address.
 */

export interface StudioWorkspaceProps {
  canGenerate: boolean;
  anyAvailable: boolean;
  usageLine: string | null;
  getBuilderDraft: () => Record<string, unknown> | undefined;
}

function NewProjectDialog({ session, onClose }: { session: StudioSession; onClose: () => void }) {
  const [mode, setMode] = useState<StudioMode>(session.mode);
  const [aspect, setAspect] = useState<StudioAspect>(session.aspect);
  return (
    <Dialog label="Novo projeto" onClose={onClose}>
      <div className="ws-form">
        {session.dirty && (
          <Alert kind="warning">
            O projeto aberto tem alterações que não foram salvas. Começar outro descarta essas
            alterações; salve antes se quiser mantê-las.
          </Alert>
        )}
        <div className="ws-choice" role="radiogroup" aria-label="Tipo de peça">
          {(['image', 'video'] as const).map((option) => (
            <label
              key={option}
              className={`ws-choice-card${mode === option ? ' ws-choice-on' : ''}`}
            >
              <input
                type="radio"
                name="ws-new-mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
              />
              <strong>{option === 'image' ? 'Imagem' : 'Vídeo'}</strong>
              <span className="muted">
                {option === 'image'
                  ? 'Camadas de imagem, texto e logo; sai em PNG ou JPG.'
                  : 'Linha do tempo com vídeo, áudio, texto e legenda; sai em MP4.'}
              </span>
            </label>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Formato</span>
          <select
            className="control"
            value={aspect}
            onChange={(event) => setAspect(event.target.value as StudioAspect)}
          >
            {(['16:9', '9:16', '1:1', '4:5'] as const).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <div className="studio-save-actions">
          <Button
            type="button"
            onClick={() => {
              session.newProject({ mode, aspect, force: true });
              onClose();
            }}
          >
            Começar
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ExportImageDialog({ session, onClose }: { session: StudioSession; onClose: () => void }) {
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState(90);
  return (
    <SaveToDriveDialog
      label="Exportar imagem para o Drive"
      defaultName={session.projectName}
      defaultFolderId={session.lastFolder?.id ?? null}
      replace={null}
      hint={
        <div className="ws-form">
          <div className="ws-segment" role="group" aria-label="Formato do arquivo">
            {(['png', 'jpeg'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`ws-segment-btn${format === option ? ' ws-segment-on' : ''}`}
                aria-pressed={format === option}
                onClick={() => setFormat(option)}
              >
                {option === 'png' ? 'PNG' : 'JPG'}
              </button>
            ))}
          </div>
          {format === 'jpeg' && (
            <label className="field">
              <span className="field-label">Qualidade ({quality})</span>
              <input
                type="range"
                min={60}
                max={100}
                value={quality}
                onChange={(event) => setQuality(Number(event.target.value))}
              />
            </label>
          )}
          <p className="field-hint">
            Sai no tamanho do formato escolhido ({session.aspect}). PNG guarda transparência; JPG
            fica menor.
          </p>
        </div>
      }
      actions={[
        {
          label: 'Exportar',
          primary: true,
          run: (choice) => {
            const ext = format === 'png' ? '.png' : '.jpg';
            const name = choice.name.toLowerCase().endsWith(ext)
              ? choice.name
              : `${choice.name}${ext}`;
            void session.exportImage({ ...choice, name, format, quality: quality / 100 });
            onClose();
          },
        },
      ]}
      onClose={onClose}
    />
  );
}

export function StudioWorkspace({
  canGenerate,
  anyAvailable,
  usageLine,
  getBuilderDraft,
}: StudioWorkspaceProps) {
  const session = useStudioSession();
  const [panel, setPanel] = useState<RailPanel | null>(null);
  const [dialog, setDialog] = useState<TopBarDialog | null>(null);
  useStudioShortcuts(session, { onSave: () => setDialog('save') });

  const replaceProject =
    session.projectFile &&
    session.lastFolder &&
    session.projectFile.folderId === session.lastFolder.id
      ? {
          id: session.projectFile.id,
          name: `${session.projectName}${STUDIO_PROJECT_SUFFIX}`,
          folderId: session.lastFolder.id,
        }
      : null;

  const emptyState: ReactNode = (
    <div className="ws-start" role="group" aria-label="Comece por aqui">
      <h2>Comece por aqui</h2>
      <p className="muted">
        Uma peça começa com uma imagem ou um vídeo na tela. Escolha de onde ela vem:
      </p>
      <div className="ws-start-actions">
        <Button type="button" variant="ghost" onClick={() => setDialog('open')}>
          Abrir do Drive
        </Button>
        <Button type="button" variant="ghost" onClick={() => setPanel('library')}>
          Escolher da biblioteca
        </Button>
        <Button type="button" variant="ghost" onClick={() => setPanel('generate')}>
          Gerar com IA
        </Button>
      </div>
    </div>
  );

  const panelBody: Record<RailPanel, ReactNode> = {
    library: <LibraryPanel session={session} />,
    generate: (
      <GeneratePanel session={session} canGenerate={canGenerate} anyAvailable={anyAvailable} />
    ),
    text: <TextPanel session={session} />,
    elements: <ElementsPanel session={session} />,
    audio: <AudioPanel session={session} />,
  };

  const current = session.render;
  return (
    <div className={`ws${panel ? ' ws-panel-open' : ''}`}>
      <TopBar session={session} usageLine={usageLine} onDialog={setDialog} />

      {(session.notice || session.progress || session.busy) && (
        <div className="ws-status">
          {session.notice && <Alert kind={session.notice.kind}>{session.notice.text}</Alert>}
          {session.progress && (
            <div className="studio-progress" role="status">
              <span>{session.progress.message}</span>
              <div className="studio-progress-bar">
                <span style={{ width: `${session.progress.done}%` }} />
              </div>
              <span className="mono">{session.progress.done}%</span>
              <button type="button" className="link-button" onClick={() => session.cancel()}>
                Cancelar
              </button>
            </div>
          )}
          {session.busy && !session.progress && (
            <p className="muted" role="status">
              {session.busy}
            </p>
          )}
        </div>
      )}

      <div className="ws-main">
        <Rail
          open={panel}
          onToggle={(next) => setPanel((value) => (value === next ? null : next))}
        />
        {panel && (
          <RailPanelFrame panel={panel} onClose={() => setPanel(null)}>
            {panelBody[panel]}
          </RailPanelFrame>
        )}
        <Stage session={session} emptyState={emptyState} />
        <aside className="ws-right" aria-label="Propriedades e agente">
          <PropertiesPanel session={session} />
          <AgentDrawer
            session={session}
            canGenerate={canGenerate}
            getBuilderDraft={getBuilderDraft}
          />
        </aside>
      </div>

      <BottomDock session={session} />

      {current && (
        <div className="studio-render" role="status">
          <strong>
            Render no servidor:{' '}
            {current.state === 'pending'
              ? 'na fila (o worker pega quando estiver livre)'
              : current.state === 'running'
                ? 'renderizando'
                : current.state === 'done'
                  ? 'pronto'
                  : 'falhou'}
          </strong>
          {current.state === 'failed' && <span className="muted">{current.error}</span>}
          {current.file && (
            <span>
              Salvo no Drive como "{current.destination.name}" (versão {current.file.version}).{' '}
              <Link to="/drive">Abrir o Drive</Link>
            </span>
          )}
          {current.unsupported.length > 0 && (
            <span className="muted">
              O servidor não reproduziu: {current.unsupported.join('; ')}
            </span>
          )}
          <button type="button" className="link-button" onClick={() => session.dismissRender()}>
            Fechar
          </button>
        </div>
      )}

      {dialog === 'new' && <NewProjectDialog session={session} onClose={() => setDialog(null)} />}
      {dialog === 'open' && (
        <DriveFilePicker
          label="Abrir do Drive"
          accept={['project', 'video', 'image', 'audio', 'subtitle']}
          initialFolderId={session.lastFolder?.id ?? null}
          onPick={(file, folder) => {
            setDialog(null);
            void session.addDriveFile(file, folder);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'save' && (
        <SaveToDriveDialog
          label="Salvar projeto no Drive"
          defaultName={session.projectName}
          defaultFolderId={session.lastFolder?.id ?? null}
          replace={replaceProject}
          hint={
            <p className="field-hint">
              O projeto guarda os cortes e cita os arquivos do Drive pelo id; nada é copiado.
            </p>
          }
          actions={[
            {
              label: 'Salvar',
              primary: true,
              run: (choice) => {
                setDialog(null);
                void session.saveProject(choice);
              },
            },
          ]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'export' && session.mode === 'image' && (
        <ExportImageDialog session={session} onClose={() => setDialog(null)} />
      )}
      {dialog === 'export' && session.mode === 'video' && (
        <SaveToDriveDialog
          label="Exportar vídeo para o Drive"
          defaultName={session.projectName}
          defaultFolderId={session.lastFolder?.id ?? null}
          replace={null}
          hint={
            <p className="field-hint">
              {session.browserExport.reason ??
                `No navegador sai na hora, em H.264 a 5 Mbps. No servidor entra numa fila e sai a 8 Mbps. Acima de ${STUDIO_BROWSER_EXPORT_MAX_SECONDS / 60} minutos, melhor no servidor.`}
            </p>
          }
          actions={[
            {
              label: 'Exportar no navegador',
              primary: session.browserExport.available,
              disabled: !session.browserExport.available,
              run: (choice) => {
                setDialog(null);
                void session.exportVideo(choice, 'browser');
              },
            },
            {
              label: 'Renderizar no servidor',
              primary: !session.browserExport.available,
              run: (choice) => {
                setDialog(null);
                void session.exportVideo(choice, 'server');
              },
            },
          ]}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'shortcuts' && (
        <Dialog label="Atalhos do teclado" onClose={() => setDialog(null)}>
          <dl className="ws-shortcuts">
            {STUDIO_SHORTCUTS.map((item) => (
              <div key={item.keys}>
                <dt className="mono">{item.keys}</dt>
                <dd>{item.does}</dd>
              </div>
            ))}
          </dl>
          <p className="field-hint">Os atalhos não agem enquanto você escreve num campo.</p>
        </Dialog>
      )}
    </div>
  );
}
