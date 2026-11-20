export type ClipType = "text" | "code" | "link" | "image";

export interface ClipItem {
  id: string;
  type: ClipType;
  /** Text content; for images, a generated label like "Image 1440×900". */
  text: string;
  /** PNG data URL for image items. */
  dataUrl?: string;
  width?: number;
  height?: number;
  pinned: boolean;
  copiedAt: number; // epoch ms
  /** App that was in front when it was copied (e.g. "Slack"), if known. */
  source?: string;
  /** A file/folder path copied in Finder. */
  isFile?: boolean;
}

export type Filter = "All" | "Text" | "Links" | "Images" | "Code" | "Pinned";

export const FILTERS: Filter[] = ["All", "Text", "Links", "Images", "Code", "Pinned"];

export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  theme: ThemePref;
  /** Max unpinned history items. 0 = unlimited. */
  historyLimit: number;
  /** Capture images from the clipboard (off saves memory/disk). */
  captureImages: boolean;
}

export const HISTORY_LIMITS = [100, 500, 1000, 0] as const;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  historyLimit: 500,
  captureImages: true,
};
