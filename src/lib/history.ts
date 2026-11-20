import { demoHistory, isDemo } from "./demo";
import { classify } from "./detect";
import type { ClipItem } from "../types";

/**
 * History lives in a native SQLite database (src-tauri/src/store.rs),
 * written by the clipboard watcher the moment something is copied. This
 * module is a thin client: it reads the list and forwards edits. It never
 * writes the whole history back, so nothing here can lose or clobber it.
 */

export const isTauri = "__TAURI_INTERNALS__" in window;

/** A row as the native store returns it. */
export interface StoredItem {
  id: string;
  kind: "text" | "file" | "image";
  text: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  pinned: boolean;
  copiedAt: number;
  source?: string;
}

export function toClipItem(s: StoredItem): ClipItem {
  const item: ClipItem = {
    id: s.id,
    // File paths are shown as plain text; link/code is derived from text
    type: s.kind === "image" ? "image" : s.kind === "file" ? "text" : classify(s.text),
    text: s.text,
    pinned: s.pinned,
    copiedAt: s.copiedAt,
  };
  if (s.dataUrl) item.dataUrl = s.dataUrl;
  if (s.source) item.source = s.source;
  if (s.kind === "file") item.isFile = true;
  if (s.width != null) item.width = s.width;
  if (s.height != null) item.height = s.height;
  return item;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/**
 * Newest store version this view is known to fully reflect. Every native
 * change bumps the version by one; a gap means this view missed something
 * and should reload (see `historyChanged`).
 */
let seenVersion = 0;

/** Record a version we just applied; only advances without gaps. */
export function noteVersion(v: number): void {
  if (v === seenVersion + 1) seenVersion = v;
}

export async function loadHistory(): Promise<ClipItem[]> {
  if (!isTauri) {
    if (!isDemo) return [];
    return demoHistory().map(toClipItem);
  }
  try {
    const { items, version } = await invoke<{ items: StoredItem[]; version: number }>(
      "history_list",
    );
    seenVersion = version;
    return items.map(toClipItem);
  } catch (e) {
    console.error("loadHistory failed", e);
    return [];
  }
}

/** True if the store changed in ways this view hasn't seen. */
export async function historyChanged(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return (await invoke<number>("history_version")) !== seenVersion;
  } catch {
    return false;
  }
}

async function edit(cmd: string, args?: Record<string, unknown>): Promise<void> {
  if (!isTauri) return;
  try {
    noteVersion(await invoke<number>(cmd, args));
  } catch (e) {
    console.error(`${cmd} failed`, e);
  }
}

export const setPinned = (id: string, pinned: boolean) =>
  edit("history_set_pinned", { id, pinned });
export const removeItem = (id: string) => edit("history_delete", { id });
export const clearUnpinned = () => edit("history_clear");
/** The limit is stored natively too, so captures made before the UI loads honor it. */
export const setHistoryLimit = (limit: number) => edit("history_set_limit", { limit });
