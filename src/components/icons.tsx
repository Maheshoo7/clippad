import type { ReactNode } from "react";
import type { ClipItem } from "../types";

/** Small outline icons (Lucide-style strokes) used across the panel. */
function Svg({ size = 14, width = 2, children }: { size?: number; width?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const TextIcon = ({ size }: P) => (
  <Svg size={size}><path d="M4 6h16M4 12h12M4 18h8" /></Svg>
);
export const LinkIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
);
export const CodeIcon = ({ size }: P) => (
  <Svg size={size}><path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16" /></Svg>
);
export const ImageIcon = ({ size }: P) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="m21 16-5-5-9 9" />
  </Svg>
);
export const FolderIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export const PinIcon = ({ size, filled }: P & { filled?: boolean }) => (
  <svg
    width={size ?? 14}
    height={size ?? 14}
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
  </svg>
);
export const TrashIcon = ({ size }: P) => (
  <Svg size={size}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </Svg>
);

/** The icon that stands for a clip's kind in the list. */
export function TypeIcon({ item, size = 16 }: { item: ClipItem; size?: number }) {
  if (item.isFile) return <FolderIcon size={size} />;
  switch (item.type) {
    case "link": return <LinkIcon size={size} />;
    case "code": return <CodeIcon size={size} />;
    case "image": return <ImageIcon size={size} />;
    default: return <TextIcon size={size} />;
  }
}
