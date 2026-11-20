import { isTauri, noteVersion, toClipItem, type StoredItem } from "./history";
import type { ClipItem } from "../types";

/**
 * Capture happens natively (src-tauri/src/clipwatch.rs): every clipboard
 * change is committed to the SQLite history first, then announced here.
 * Polling in the webview lost copies — WebKit throttles timers in hidden
 * pages to minutes apart — and so did keeping new items only in memory.
 */

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Tell the native watcher whether to snapshot images (setting changed). */
export async function setCaptureImages(enabled: boolean): Promise<void> {
  if (!isTauri) return;
  try {
    await invokeCmd("set_capture_images", { enabled });
  } catch (e) {
    console.error("set_capture_images failed", e);
  }
}

/**
 * Apply items the native watcher has just stored. Returns a stop function.
 * An event this view misses (e.g. sent before it subscribed) shows up as a
 * version gap, and the next `historyChanged()` check reloads the list.
 */
export function startWatcher(onItem: (item: ClipItem) => void): () => void {
  if (!isTauri) return () => {};
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ item: StoredItem; version: number }>("clipboard-changed", (e) => {
        if (stopped) return;
        onItem(toClipItem(e.payload.item));
        noteVersion(e.payload.version);
      }),
    )
    .then((u) => {
      if (stopped) u();
      else unlisten = u;
    })
    .catch((e) => console.error("clipboard listen failed", e));
  return () => {
    stopped = true;
    unlisten?.();
  };
}

/**
 * Put an item back on the system clipboard (the "paste" action). Returns
 * the item's new `copiedAt`.
 */
export async function copyItem(item: ClipItem): Promise<number> {
  if (!isTauri) {
    await navigator.clipboard.writeText(item.text);
    return Date.now();
  }
  // Natively: writes the clipboard, marks the write as ours so it isn't
  // re-captured, and moves the item to the top of the stored history.
  const { copiedAt, version } = await invokeCmd<{ copiedAt: number; version: number }>(
    "history_copy",
    { id: item.id },
  );
  noteVersion(version);
  return copiedAt;
}
