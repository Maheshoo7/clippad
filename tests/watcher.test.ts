import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipItem } from "../src/types";
import type { StoredItem } from "../src/lib/history";

// Capture → item conversion, de-duplication, trimming and persistence are
// native now (src-tauri/src/clipwatch.rs + store.rs, tested with
// `cargo test`). These tests cover the webview's side of the contract.

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
type Payload = { item: StoredItem; version: number };
let emit: ((p: Payload) => void) | null = null;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: (e: { payload: Payload }) => void) => {
    if (event === "clipboard-changed") emit = (payload) => cb({ payload });
    return unlisten;
  },
}));

const row = (p: Partial<StoredItem>): StoredItem => ({
  id: "r1",
  kind: "text",
  text: "hello",
  pinned: false,
  copiedAt: 1_000,
  ...p,
});

let captured: ClipItem[];
const onItem = (it: ClipItem) => captured.push(it);

async function load() {
  vi.resetModules();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const clipboard = await import("../src/lib/clipboard");
  const history = await import("../src/lib/history");
  return { ...clipboard, ...history };
}

/** Wait until the watcher has subscribed to native change events. */
async function flush() {
  await vi.waitFor(() => expect(emit).not.toBeNull());
}

beforeEach(() => {
  captured = [];
  emit = null;
  invoke.mockReset();
  unlisten.mockReset();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("clipboard watcher", () => {
  it("applies items the native store recorded, deriving link/code from text", async () => {
    const { startWatcher } = await load();
    startWatcher(onItem);
    await flush();
    emit!({ item: row({ id: "a", text: "https://example.com" }), version: 2 });
    emit!({ item: row({ id: "b", text: "const x = () => 1;\nreturn x;" }), version: 3 });
    emit!({ item: row({ id: "c", kind: "file", text: "/Users/me/notes.js" }), version: 4 });
    expect(captured.map((c) => [c.id, c.type])).toEqual([
      ["a", "link"],
      ["b", "code"],
      ["c", "text"],
    ]);
    expect(captured[0].copiedAt).toBe(1_000);
  });

  it("passes images through with their data URL and size", async () => {
    const { startWatcher } = await load();
    startWatcher(onItem);
    await flush();
    emit!({
      item: row({ kind: "image", text: "Image 2×3", dataUrl: "data:image/png;base64,X", width: 2, height: 3 }),
      version: 2,
    });
    expect(captured[0]).toMatchObject({ type: "image", dataUrl: "data:image/png;base64,X", width: 2, height: 3 });
  });

  it("detects a missed change via the version and reloads", async () => {
    const { startWatcher, loadHistory, historyChanged } = await load();
    invoke.mockImplementation(async (cmd) =>
      cmd === "history_list" ? { items: [row({})], version: 5 } : 7,
    );
    startWatcher(onItem);
    await flush();
    expect(await loadHistory()).toHaveLength(1);
    // v6 never arrived; v7 did
    emit!({ item: row({ id: "z" }), version: 7 });
    expect(await historyChanged()).toBe(true);
  });

  it("stays in sync when every change arrives in order", async () => {
    const { startWatcher, loadHistory, historyChanged } = await load();
    invoke.mockImplementation(async (cmd) =>
      cmd === "history_list" ? { items: [], version: 5 } : 6,
    );
    startWatcher(onItem);
    await flush();
    await loadHistory();
    emit!({ item: row({}), version: 6 });
    expect(await historyChanged()).toBe(false);
  });

  it("copies back natively and returns the new copiedAt", async () => {
    const { copyItem } = await load();
    invoke.mockResolvedValue({ copiedAt: 42, version: 2 });
    const at = await copyItem({ id: "r1", type: "text", text: "hi", pinned: false, copiedAt: 1 });
    expect(invoke).toHaveBeenCalledWith("history_copy", { id: "r1" });
    expect(at).toBe(42);
  });

  it("forwards edits to the native store", async () => {
    const { setPinned, removeItem, clearUnpinned, setHistoryLimit } = await load();
    invoke.mockResolvedValue(2);
    await setPinned("a", true);
    await removeItem("b");
    await clearUnpinned();
    await setHistoryLimit(100);
    expect(invoke.mock.calls).toEqual([
      ["history_set_pinned", { id: "a", pinned: true }],
      ["history_delete", { id: "b" }],
      ["history_clear", undefined],
      ["history_set_limit", { limit: 100 }],
    ]);
  });

  it("stops listening when stopped", async () => {
    const { startWatcher } = await load();
    const stop = startWatcher(onItem);
    await flush();
    await new Promise((r) => setTimeout(r, 0)); // let the unlisten handle land
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
