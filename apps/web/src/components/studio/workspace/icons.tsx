import type { SVGProps } from 'react';

/**
 * The workspace's icons: one stroke system, 20 px, always beside a text label
 * (or under one, on the rail), never carrying meaning alone.
 */

const base: SVGProps<SVGSVGElement> = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const LibraryIcon = () => (
  <svg {...base}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 15l5-5 4 4 3-3 6 6" />
    <circle cx="16" cy="9" r="1.5" />
  </svg>
);
export const SparkIcon = () => (
  <svg {...base}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  </svg>
);
export const TextIcon = () => (
  <svg {...base}>
    <path d="M5 6h14M12 6v13M9 19h6" />
  </svg>
);
export const ShapesIcon = () => (
  <svg {...base}>
    <rect x="3" y="12" width="9" height="9" rx="1.5" />
    <circle cx="16" cy="8" r="5" />
  </svg>
);
export const AudioIcon = () => (
  <svg {...base}>
    <path d="M9 18V6l10-2v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="16" r="2.5" />
  </svg>
);
export const UndoIcon = () => (
  <svg {...base}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </svg>
);
export const RedoIcon = () => (
  <svg {...base}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </svg>
);
export const PlayIcon = () => (
  <svg {...base}>
    <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />
  </svg>
);
export const PauseIcon = () => (
  <svg {...base}>
    <rect x="6" y="5" width="4" height="14" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" fill="currentColor" stroke="none" />
  </svg>
);
export const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg {...base} width={16} height={16}>
    <path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
  </svg>
);
export const CloseIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const GridIcon = () => (
  <svg {...base}>
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
);
export const CaptionsIcon = () => (
  <svg {...base}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 12h4M7 15h7M14 12h3" />
  </svg>
);
export const FolderIcon = () => (
  <svg {...base}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
export const HelpIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" />
  </svg>
);
