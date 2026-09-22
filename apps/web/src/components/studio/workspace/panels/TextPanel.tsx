import type { StudioSession, TextPreset } from '../../session.js';

/** Three ways to write on the canvas, each shown in its own size. */
const PRESETS: { key: TextPreset; label: string; sample: string; hint: string }[] = [
  {
    key: 'title',
    label: 'Título',
    sample: 'Sua franquia começa aqui',
    hint: '72 px, semibold, centrado',
  },
  { key: 'subtitle', label: 'Subtítulo', sample: 'Formatação e expansão', hint: '44 px, regular' },
  {
    key: 'body',
    label: 'Corpo',
    sample: 'Fale com a Wings e receba o diagnóstico.',
    hint: '28 px, regular, à esquerda',
  },
];

export function TextPanel({ session }: { session: StudioSession }) {
  const ready = session.status === 'ready' && session.busy === null;
  return (
    <>
      <p className="muted">
        O texto entra na posição do cursor e pode ser editado na tela ou em Propriedades.
      </p>
      <ul className="ws-presets">
        {PRESETS.map((preset) => (
          <li key={preset.key}>
            <button
              type="button"
              className={`ws-preset ws-preset-${preset.key}`}
              disabled={!ready}
              onClick={() => void session.addText(preset.key)}
            >
              <span className="ws-preset-sample">{preset.sample}</span>
              <span className="ws-preset-meta">
                {preset.label} · {preset.hint}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
