import type { StudioSession } from '../../session.js';
import { DriveBrowser } from './LibraryPanel.js';

/** Music and narration come from the Drive; the editor mixes, it does not record. */
export function AudioPanel({ session }: { session: StudioSession }) {
  return (
    <>
      <p className="muted">
        Narração e música vêm do Drive; grave ou gere fora e envie para lá. O áudio entra numa faixa
        própria, na posição do cursor.
      </p>
      <DriveBrowser session={session} accept={new Set(['audio'])} />
    </>
  );
}
