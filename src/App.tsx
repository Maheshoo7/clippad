import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipItem, Filter, Settings, ThemePref } from "./types";
import { DEFAULT_SETTINGS, FILTERS, HISTORY_LIMITS } from "./types";
import { copyItem, setCaptureImages, startWatcher } from "./lib/clipboard";
import {
  clearUnpinned,
  historyChanged,
  isTauri,
  loadHistory,
  removeItem,
  setHistoryLimit,
  setPinned,
} from "./lib/history";
import { hideOverlay, quitApp, registerHotkey, setCompactWidth, setExpanded as resizeWindow, watchFocus } from "./lib/overlay";
import { ensureAutostartDefault, getAutostart, loadSettings, saveSettings, setAutostart } from "./lib/settings";
import { initTray, petReact } from "./lib/tray";
import { CatSit, CatSleep } from "./components/catPoses";
import { PadCat } from "./components/PadCat";
import { CodeIcon, ImageIcon, LinkIcon, PinIcon, TextIcon, TrashIcon, TypeIcon } from "./components/icons";
import { relativeTime } from "./lib/time";

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LIMIT_LABEL = (n: number) => (n === 0 ? "Unlimited" : n.toLocaleString());

const TYPE_LABEL: Record<ClipItem["type"], string> = {
  text: "Text",
  code: "Code",
  link: "Link",
  image: "Image",
};

const TIP_DELAY = 500; // ms of rest (hover or keyboard) before a tooltip shows

type TipPlace = "right" | "left" | "above";

/** Position a tooltip beside a row: right, then left, then above as a last
 *  resort — never on top of the row itself or (when possible) its neighbours. */
function placeTip(el: HTMLElement): { top: number; left: number; place: TipPlace } {
  const r = el.getBoundingClientRect();
  const GAP = 8;
  const TIP_W = 340; // matches .row-tip max-width
  const EST_H = 260; // rough cap; real height honoured by max-height
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let place: TipPlace = "right";
  let left = r.right + GAP;
  if (left + TIP_W + 8 > vw) {
    const leftSide = r.left - GAP - TIP_W;
    if (leftSide >= 8) {
      left = leftSide;
      place = "left";
    } else {
      left = Math.max(8, Math.min(r.left, vw - TIP_W - 8));
      place = "above";
    }
  }

  // "above" anchors the tooltip's *bottom* at the row's top (CSS translateY(-100%)),
  // so it hugs the row regardless of its height.
  const top =
    place === "above"
      ? r.top - GAP
      : Math.max(8, Math.min(r.top, vh - EST_H - 8));
  return { top, left, place };
}

/** A tooltip is only worth showing if the row doesn't already show it all. */
function tipAddsInfo(row: HTMLElement, it: ClipItem): boolean {
  const line = row.querySelector(".line1") as HTMLElement | null;
  const truncated = !!line && line.scrollWidth > line.clientWidth + 1;
  return truncated || it.text.trim() !== firstLine(it.text);
}

const FILTER_ICON: Partial<Record<Filter, ReactNode>> = {
  Text: <TextIcon size={12} />,
  Links: <LinkIcon size={12} />,
  Images: <ImageIcon size={12} />,
  Code: <CodeIcon size={12} />,
  Pinned: <PinIcon size={12} />,
};

/** Row identity: a pinned clip appears in the main list ("r") and Pinned ("p"). */
const rowKey = (section: "r" | "p", id: string) => `${section}:${id}`;

function matches(it: ClipItem, filter: Filter, query: string): boolean {
  if (filter === "Pinned" && !it.pinned) return false;
  if (filter === "Text" && it.type !== "text") return false;
  if (filter === "Links" && it.type !== "link") return false;
  if (filter === "Images" && it.type !== "image") return false;
  if (filter === "Code" && it.type !== "code") return false;
  if (query && !it.text.toLowerCase().includes(query.toLowerCase())) return false;
  return true;
}

/**
 * Row label: the first line with visible content (clips can start with
 * blank lines). Whitespace-only clips show their characters as symbols.
 */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return text
    .replace(/\r?\n/g, "↵")
    .replace(/\t/g, "→")
    .replace(/ /g, "·")
    .replace(/[^↵→·]/g, "␣")
    .slice(0, 40);
}

/** Unpinned images kept — matches MAX_STORED_IMAGES in src-tauri/src/store.rs. */
export const MAX_IMAGES = 30;

/**
 * Keep all pinned items, the newest `limit` unpinned ones (0 = unlimited),
 * and at most MAX_IMAGES unpinned images. Mirrors the native store's trim,
 * so what's shown is exactly what's on disk.
 */
export function trimItems(items: ClipItem[], limit: number): ClipItem[] {
  const newest = items
    .filter((i) => !i.pinned)
    .sort((a, b) => b.copiedAt - a.copiedAt);
  let images = 0;
  const kept = newest.filter((i) => i.type !== "image" || ++images <= MAX_IMAGES);
  const keep = new Set((limit > 0 ? kept.slice(0, limit) : kept).map((i) => i.id));
  if (keep.size === newest.length) return items;
  return items.filter((i) => i.pinned || keep.has(i.id));
}

export default function App() {
  const [items, setItems] = useState<ClipItem[]>([]);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [hotkeyOk, setHotkeyOk] = useState(true);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [, setTick] = useState(0);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tip, setTip] = useState<
    { text: string; top: number; left: number; place: TipPlace } | null
  >(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What last moved the selection, so we can react correctly to selId changes:
  // "key" = arrow keys (scroll into view + show tip), "mouse" = hover (show tip
  // only), null = programmatic (load / new clip / repair — do nothing).
  const navSource = useRef<"key" | "mouse" | null>(null);

  // Pinning *copies* a clip into the Pinned section: it also stays in its
  // place in the main list. So one clip can be two rows; rows (and the
  // selection, `selId`) are keyed by section + id — see rowKey.
  const visible = useMemo(() => {
    const vis = items
      .filter((it) => matches(it, filter, query))
      .sort((a, b) => b.copiedAt - a.copiedAt);
    const pinned = vis.filter((i) => i.pinned);
    // The Pinned filter shows just the Pinned section, without repeats
    const recent = filter === "Pinned" ? [] : vis;
    const rows = [
      ...recent.map((it) => ({ it, key: rowKey("r", it.id) })),
      ...pinned.map((it) => ({ it, key: rowKey("p", it.id) })),
    ];
    return { recent, pinned, rows, all: vis };
  }, [items, filter, query]);

  const selRow = visible.rows.find((r) => r.key === selId) ?? visible.rows[0] ?? null;
  const selected = selRow?.it ?? null;

  // Refs so global handlers always see fresh state
  const selKey = selRow?.key ?? null;
  const stateRef = useRef({ visible, selected, selKey, expanded, settingsOpen, query, settings });
  stateRef.current = { visible, selected, selKey, expanded, settingsOpen, query, settings };

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1400);
  }, []);

  const addItem = useCallback((item: ClipItem) => {
    setItems((prev) => {
      // The native store already de-duplicated: re-copying an existing
      // item comes back with that item's id and a fresh copiedAt.
      const dup = prev.find((p) => p.id === item.id);
      if (dup) {
        // Move selection to the freshly re-copied item
        setSelId(rowKey("r", dup.id));
        return prev.map((p) =>
          p.id === dup.id ? { ...p, copiedAt: item.copiedAt } : p,
        );
      }
      // Move selection to the newly captured item
      setSelId(rowKey("r", item.id));
      return trimItems([item, ...prev], stateRef.current.settings.historyLimit);
    });
  }, []);

  // The transparent band above the panel overlaps the menu bar when the
  // panel hangs off the tray icon (see toggleOverlayAt). It swallows clicks
  // meant for the menu bar, so treat a click there as "clicked outside".
  useEffect(() => {
    if (!isTauri) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t === document.documentElement || t === document.body || (t as Element)?.id === "root") {
        void hideOverlay();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const doCopy = useCallback(
    async (item: ClipItem | null) => {
      if (!item) return;
      try {
        const copiedAt = await copyItem(item);
        setItems((prev) => prev.map((p) => (p.id === item.id ? { ...p, copiedAt } : p)));
        if (isTauri) {
          setPasting(true);
          setTimeout(() => {
            void hideOverlay();
            setPasting(false);
          }, 160);
        } else {
          showToast("Copied");
        }
      } catch (e) {
        console.error(e);
        showToast("Copy failed");
      }
    },
    [showToast],
  );

  const togglePin = useCallback(
    (item: ClipItem | null) => {
      if (!item) return;
      const pinned = !item.pinned;
      setItems((prev) =>
        trimItems(
          prev.map((p) => (p.id === item.id ? { ...p, pinned } : p)),
          stateRef.current.settings.historyLimit,
        ),
      );
      void setPinned(item.id, pinned);
      showToast(item.pinned ? "Unpinned" : "Pinned");
    },
    [showToast],
  );

  const deleteItem = useCallback(
    (item: ClipItem | null) => {
      if (!item) return;
      setItems((prev) => prev.filter((p) => p.id !== item.id));
      void removeItem(item.id);
      showToast("Deleted");
    },
    [showToast],
  );

  const move = useCallback((delta: number) => {
    const { visible: vis, selKey } = stateRef.current;
    if (!vis.rows.length) return;
    const idx = vis.rows.findIndex((r) => r.key === selKey);
    const next = Math.min(Math.max(idx + delta, 0), vis.rows.length - 1);
    navSource.current = "key";
    setSelId(vis.rows[next].key);
  }, []);

  const toggleExpand = useCallback((next: boolean) => {
    setExpanded(next);
    void resizeWindow(next);
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
    if (patch.historyLimit !== undefined) {
      setItems((prev) => trimItems(prev, patch.historyLimit!));
      void setHistoryLimit(patch.historyLimit);
    }
    if (patch.captureImages !== undefined) void setCaptureImages(patch.captureImages);
  }, []);

  const clearHistory = useCallback(() => {
    setItems((prev) => prev.filter((p) => p.pinned));
    void clearUnpinned();
    setConfirmClear(false);
    showToast("History cleared");
  }, [showToast]);

  const toggleAutostart = useCallback(async () => {
    const next = !autostart;
    setAutostartState(next); // optimistic
    const status = await setAutostart(next);
    if (status === null) {
      setAutostartState(!next);
      showToast("Couldn't change login item");
      return;
    }
    setAutostartState(status === "enabled");
    if (status === "requires-approval") {
      showToast("Allow ClipPad in System Settings → Login Items");
    }
  }, [autostart, showToast]);

  // Compact panel = exactly the filter row's width, so the gap after
  // "Pinned" matches the gap before "All". Re-measured whenever a chip's
  // size changes (fonts/styles settling, the count on "All" growing).
  useLayoutEffect(() => {
    const row = chipsRef.current;
    if (!row) return;
    const measure = () => {
      const last = row.lastElementChild as HTMLElement | null;
      if (!last) return;
      const pad = parseFloat(getComputedStyle(row).paddingLeft) || 12;
      // Layout offsets, not getBoundingClientRect: the panel's open
      // animation scales it, which would skew a visual measurement.
      const fit = last.offsetLeft + last.offsetWidth + pad; // .chips is position: relative
      const panelW = Math.min(560, Math.max(360, Math.ceil(fit)));
      document.documentElement.style.setProperty("--compact-w", `${panelW}px`);
      void setCompactWidth(panelW + 60);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    for (const chip of Array.from(row.children)) ro.observe(chip);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, []);

  // ---- theme ----
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        settings.theme === "system" ? (mq.matches ? "dark" : "light") : settings.theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [settings.theme]);

  // ---- lifecycle ----
  useEffect(() => {
    let cancelled = false;
    let stopWatcher = () => {};
    let unlistenFocus = () => {};
    void (async () => {
      const loadedSettings = await loadSettings();
      if (cancelled) return;
      setSettings(loadedSettings);

      await setCaptureImages(loadedSettings.captureImages);
      await setHistoryLimit(loadedSettings.historyLimit);
      // Subscribe before loading, so nothing stored in between is missed
      stopWatcher = startWatcher(addItem);
      if (cancelled) { stopWatcher(); return; }
      const initial = await loadHistory();
      if (cancelled) return;
      setItems(trimItems(initial, loadedSettings.historyLimit));

      const ok = await registerHotkey();
      setHotkeyOk(ok || !isTauri);
      await initTray();
      setAutostartState(await ensureAutostartDefault());

      unlistenFocus = await watchFocus((focused) => {
        if (focused) {
          // Fresh summon: refresh relative times, focus search
          setTick((t) => t + 1);
          searchRef.current?.focus();
          // Catch up on anything stored that this view didn't hear about
          void historyChanged().then(async (changed) => {
            if (!changed) return;
            const fresh = await loadHistory();
            setItems(trimItems(fresh, stateRef.current.settings.historyLimit));
          });
          // Login item may have been changed in System Settings meanwhile
          void getAutostart().then((on) => { if (on !== null) setAutostartState(on); });
        } else {
          // Reset to the default "2-second interaction" state while hidden
          setQuery("");
          setFilter("All");
          setSelId(null);
          setSettingsOpen(false);
          setConfirmClear(false);
          setExpanded((was) => {
            if (was) void resizeWindow(false);
            return false;
          });
        }
      });
      if (cancelled) unlistenFocus();
    })();
    const tick = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      cancelled = true;
      stopWatcher();
      unlistenFocus();
      clearInterval(tick);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (tipTimer.current) clearTimeout(tipTimer.current);
    };
  }, [addItem]);

  // Keep selection valid as the list changes
  useEffect(() => {
    if (!visible.rows.length) {
      setSelId(null);
    } else if (!visible.rows.some((r) => r.key === selId)) {
      setSelId(visible.rows[0].key);
    }
  }, [visible, selId]);

  // Selection changed. Keyboard nav scrolls the row into view; both keyboard
  // and mouse reveal the tooltip after a rest delay. Programmatic changes
  // (load / new clip / repair) do neither. Any change hides the current tip.
  useEffect(() => {
    const source = navSource.current;
    navSource.current = null;
    if (tipTimer.current) { clearTimeout(tipTimer.current); tipTimer.current = null; }
    setTip(null);
    if (source === null) return;
    if (source === "key") {
      document.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
    }
    const it = stateRef.current.selected;
    if (!it || it.type === "image") return;
    tipTimer.current = setTimeout(() => {
      tipTimer.current = null;
      const el = document.querySelector(".row.sel") as HTMLElement | null;
      if (el && tipAddsInfo(el, it)) setTip({ text: it.text, ...placeTip(el) });
    }, TIP_DELAY);
  }, [selId]);

  // ---- global keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never act on keystrokes that belong to an IME composition
      if (e.isComposing || e.keyCode === 229) return;

      const { visible: vis, selected: sel, settingsOpen: inSettings, query: q } =
        stateRef.current;
      const inSearch = document.activeElement === searchRef.current;

      if (e.key === "Escape") {
        e.preventDefault();
        // Layered: settings → search text → overlay
        if (inSettings) { setSettingsOpen(false); setConfirmClear(false); return; }
        if (q) { setQuery(""); setSelId(null); searchRef.current?.focus(); return; }
        void hideOverlay();
        return;
      }

      // While settings are open, don't drive the list underneath
      if (inSettings) return;

      if (e.key === "ArrowDown") { e.preventDefault(); move(1); petReact("look_down"); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); move(-1); petReact("look_up"); return; }
      // → opens the preview pane, ← closes it. The search box always has
      // focus, so these only act when the caret is at the end / start of
      // the query — otherwise they move the caret as usual.
      const input = searchRef.current;
      const caretAtEnd = !inSearch || (input?.selectionStart === input?.value.length);
      const caretAtStart = !inSearch || input?.selectionEnd === 0;
      if (e.key === "ArrowRight" && caretAtEnd && !stateRef.current.expanded) {
        e.preventDefault(); toggleExpand(true); return;
      }
      if (e.key === "ArrowLeft" && caretAtStart && stateRef.current.expanded) {
        e.preventDefault(); toggleExpand(false); return;
      }
      if (e.key === "Enter") { e.preventDefault(); void doCopy(sel); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault(); togglePin(sel); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
        e.preventDefault(); deleteItem(sel); return;
      }
      // ⌘/Ctrl+1–9: quick-copy a recent item. (Plain digits go to search —
      // the search box has focus when the overlay opens.)
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key) && !e.altKey) {
        e.preventDefault();
        const it = vis.recent[Number(e.key) - 1];
        if (it) { setSelId(rowKey("r", it.id)); void doCopy(it); }
        return;
      }
      // Type-to-search from anywhere
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        petReact("typing");
        if (!inSearch) searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [move, doCopy, togglePin, deleteItem, toggleExpand]);

  // ---- tooltip (shows the full clip text, like a native title, with delay) ----
  const clearTip = useCallback(() => {
    if (tipTimer.current) { clearTimeout(tipTimer.current); tipTimer.current = null; }
    setTip(null);
  }, []);

  // ---- render ----
  const renderRow = (it: ClipItem, key: string, quickIdx: number | null) => {
    const line1 = firstLine(it.text);
    const isSel = key === selKey;
    const meta = it.type === "image" && it.width
      ? `${it.source ?? "Image"} · ${it.width} × ${it.height}`
      : it.source ?? (it.isFile ? "File" : TYPE_LABEL[it.type]);
    return (
      <div
        key={key}
        className={`row ${isSel ? "sel" : ""}`}
        onMouseEnter={() => { navSource.current = "mouse"; setSelId(key); }}
        onMouseLeave={clearTip}
        onClick={() => { clearTip(); void doCopy(it); }}
      >
        <div className={`ticon ${it.type === "image" && it.dataUrl ? "thumb" : ""}`}>
          {it.type === "image" && it.dataUrl ? <img src={it.dataUrl} alt="" /> : <TypeIcon item={it} />}
        </div>
        <div className="txt">
          <div className={`line1 ${it.type === "code" || it.isFile ? "code" : ""}`}>{line1}</div>
          <div className="line2">
            {it.pinned && <span className="pin-ic"><PinIcon size={10} filled /></span>}
            {meta} · {relativeTime(it.copiedAt)}
          </div>
        </div>
        {quickIdx !== null && quickIdx < 9 && <kbd className="num">⌘{quickIdx + 1}</kbd>}
        <div className="row-acts">
          <button
            className={`ract ${it.pinned ? "on" : ""}`}
            title={it.pinned ? "Unpin (⌘P)" : "Pin (⌘P)"}
            aria-label={it.pinned ? "Unpin" : "Pin"}
            onClick={(e) => { e.stopPropagation(); togglePin(it); }}
          >
            <PinIcon size={13} filled={it.pinned} />
          </button>
          <button
            className="ract danger"
            title="Delete (⌘⌫)"
            aria-label="Delete"
            onClick={(e) => { e.stopPropagation(); deleteItem(it); }}
          >
            <TrashIcon size={13} />
          </button>
          {isSel && <kbd className="enter">↵</kbd>}
        </div>
      </div>
    );
  };

  const renderPreview = () => {
    if (!selected) {
      return <div className="empty" style={{ margin: "auto" }}>Nothing selected</div>;
    }
    const it = selected;
    return (
      <>
        <div className="pv-meta">
          <span className="type">{TYPE_LABEL[it.type]}</span>
          <span className="dot">·</span>
          <span>{relativeTime(it.copiedAt)}</span>
          {it.source && (
            <>
              <span className="dot">·</span>
              <span>from {it.source}</span>
            </>
          )}
          {(it.type === "text" || it.type === "code") && (
            <>
              <span className="dot">·</span>
              <span>{it.text.length.toLocaleString()} chars</span>
            </>
          )}
          {it.type === "image" && it.width && (
            <>
              <span className="dot">·</span>
              <span>{it.width} × {it.height}</span>
            </>
          )}
          {it.pinned && (
            <>
              <span className="dot">·</span>
              <span className="pin-ic"><PinIcon size={11} filled /> Pinned</span>
            </>
          )}
        </div>
        {it.type === "image" && it.dataUrl ? (
          <div className="pv-img"><img src={it.dataUrl} alt="" /></div>
        ) : it.type === "link" ? (
          <>
            <div className="link-card"><div className="lc-url">{it.text}</div></div>
            <div style={{ flex: 1 }} />
          </>
        ) : (
          <div className={`pv-content ${it.type === "code" ? "code" : ""}`}>{it.text}</div>
        )}
        <div className="pv-foot">
          <button className="act" onClick={() => void doCopy(it)}>
            <kbd>↵</kbd> Copy &amp; close
          </button>
          <button className="act" onClick={() => togglePin(it)}>
            <kbd>⌘P</kbd> {it.pinned ? "Unpin" : "Pin"}
          </button>
          <button className="act" onClick={() => deleteItem(it)}>
            <kbd>⌘⌫</kbd> Delete
          </button>
          <div className="spacer" />
          <div className="count">{visible.all.length} clips</div>
        </div>
      </>
    );
  };

  const renderSettings = () => (
    <div className="sheet">
      <div className="sheet-head">
        <div className="sheet-title">Settings</div>
        <button
          className="gear"
          title="Close settings"
          onClick={() => { setSettingsOpen(false); setConfirmClear(false); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="sheet-body">
        <div className="set-row">
          <div className="set-txt">
            <div className="set-label">Appearance</div>
            <div className="set-sub">Follows the system unless overridden</div>
          </div>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={settings.theme === o.value}
                className={`seg-btn ${settings.theme === o.value ? "on" : ""}`}
                onClick={() => updateSettings({ theme: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-row">
          <div className="set-txt">
            <div className="set-label">History limit</div>
            <div className="set-sub">Pinned items are always kept</div>
          </div>
          <select
            className="set-select"
            value={settings.historyLimit}
            onChange={(e) => updateSettings({ historyLimit: Number(e.target.value) })}
          >
            {HISTORY_LIMITS.map((n) => (
              <option key={n} value={n}>{LIMIT_LABEL(n)} {n !== 0 ? "items" : ""}</option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <div className="set-txt">
            <div className="set-label">Capture images</div>
            <div className="set-sub">Turn off to save memory and disk</div>
          </div>
          <button
            role="switch"
            aria-checked={settings.captureImages}
            className={`switch ${settings.captureImages ? "on" : ""}`}
            onClick={() => updateSettings({ captureImages: !settings.captureImages })}
          >
            <span className="knob" />
          </button>
        </div>

        {autostart !== null && (
          <div className="set-row">
            <div className="set-txt">
              <div className="set-label">Launch at login</div>
              <div className="set-sub">Start ClipPad when you sign in</div>
            </div>
            <button
              role="switch"
              aria-checked={autostart}
              className={`switch ${autostart ? "on" : ""}`}
              onClick={() => void toggleAutostart()}
            >
              <span className="knob" />
            </button>
          </div>
        )}

        <div className="set-row">
          <div className="set-txt">
            <div className="set-label">Clear history</div>
            <div className="set-sub">
              Removes {items.filter((i) => !i.pinned).length.toLocaleString()} items; pinned are kept
            </div>
          </div>
          {confirmClear ? (
            <div className="confirm-group">
              <button className="btn danger" onClick={clearHistory}>Confirm</button>
              <button className="btn" onClick={() => setConfirmClear(false)}>Cancel</button>
            </div>
          ) : (
            <button
              className="btn danger-outline"
              onClick={() => setConfirmClear(true)}
              disabled={items.every((i) => i.pinned)}
            >
              Clear…
            </button>
          )}
        </div>

        {!hotkeyOk && (
          <div className="set-warn">
            ⚠ The global shortcut <kbd>⌘⇧V</kbd> couldn't be registered — another
            app may be using it. You can still open ClipPad from the menu-bar icon.
          </div>
        )}

        <div className="set-row">
          <div className="set-txt">
            <div className="set-label">Quit ClipPad</div>
            <div className="set-sub">Stops clipboard capture until relaunched</div>
          </div>
          <button className="btn danger-outline" onClick={() => void quitApp()}>
            Quit
          </button>
        </div>
      </div>
      <div className="sheet-foot">
        <span>
          Summon with <kbd>⌘⇧V</kbd> / <kbd>Ctrl⇧V</kbd> · after <kbd>↵</kbd>, paste with <kbd>⌘V</kbd> / <kbd>CtrlV</kbd>
        </span>
        <div className="spacer" />
        <span className="count">ClipPad 0.1.0</span>
      </div>
    </div>
  );

  return (
    <>
    {/* Speech-bubble tip pointing at the menu-bar icon (tray-anchored only):
        curved shoulders that run into the panel's top edge, rounded point */}
    <svg className="tray-arrow" viewBox="0 0 28 13" aria-hidden="true">
      <path className="fill" d="M0 11.5C6 11.5 9.5 8 11.8 3.6Q14 -.4 16.2 3.6C18.5 8 22 11.5 28 11.5V13H0Z" />
      <path className="edge" d="M0 11.5C6 11.5 9.5 8 11.8 3.6Q14 -.4 16.2 3.6C18.5 8 22 11.5 28 11.5" />
    </svg>
    <div className="panel-wrap">
    {/* The cat wanders, sits and naps on the panel's top edge */}
    <PadCat />
    <div className={`panel ${expanded ? "" : "compact"} ${pasting ? "pasting" : ""}`}>
      <div className="head">
        <div className="search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            placeholder={items.length ? `Search ${items.length.toLocaleString()} clips` : "Search clips"}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelId(null);
              // Searching means the user wants the list, not the settings sheet
              setSettingsOpen(false);
              setConfirmClear(false);
            }}
            autoFocus
          />
        </div>
        <button
          className={`gear ${settingsOpen ? "active" : ""}`}
          title="Settings"
          onClick={() => { setSettingsOpen((o) => !o); setConfirmClear(false); }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div className="chips" ref={chipsRef}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`chip ${f === filter ? "on" : ""}`}
            onClick={() => {
              setFilter(f);
              // The settings sheet covers the list; picking a filter means
              // the user wants to see the list again.
              setSettingsOpen(false);
              setConfirmClear(false);
            }}
          >
            {FILTER_ICON[f]}
            {f}
            {f === "All" && <span className="chip-n">{items.length.toLocaleString()}</span>}
          </button>
        ))}
      </div>

      <div className="body">
        <div className={`list ${visible.all.length === 0 ? "is-empty" : ""}`} onScroll={clearTip}>
          {visible.recent.length > 0 && (
            <>{visible.recent.map((it, i) => renderRow(it, rowKey("r", it.id), i))}</>
          )}
          {visible.pinned.length > 0 && (
            <>
              <div className="section-label">Pinned</div>
              {visible.pinned.map((it) => renderRow(it, rowKey("p", it.id), null))}
            </>
          )}
          {visible.all.length === 0 && (
            <div className={`empty ${items.length === 0 ? "empty-first" : "empty-none"}`}>
              {items.length === 0 ? (
                <>
                  <CatSleep className="empty-cat cat-sleep sleep" />
                  <div className="empty-title">Nothing copied yet</div>
                  <div className="empty-sub">
                    The cat is napping. Copy text, links, images or code and they’ll land here.
                  </div>
                  <div className="empty-keys">
                    <div><span className="ek"><kbd>⌘</kbd><kbd>C</kbd></span>Copy anything, anywhere</div>
                    <div><span className="ek"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>V</kbd></span>Open ClipPad</div>
                    <div><span className="ek"><kbd>↵</kbd></span>Copy a clip back</div>
                  </div>
                </>
              ) : (
                <>
                  <CatSit className="empty-cat cat-sit sit" />
                  <div className="empty-title">
                    {query ? <>No matches for “{query}”</> : <>No {filter === "Pinned" ? "pinned clips" : `${filter.toLowerCase()} clips`}</>}
                  </div>
                  <div className="empty-sub">
                    {query
                      ? filter === "All"
                        ? "The cat looked everywhere. Try fewer words."
                        : "The cat looked everywhere. Try fewer words, or check the filter."
                      : filter === "Pinned"
                        ? "Pin clips you use often with ⌘P. They stay even when history is cleared."
                        : "Nothing of this type yet."}
                  </div>
                  <div className="empty-acts">
                    {query && (
                      <button onClick={() => { setQuery(""); setSelId(null); searchRef.current?.focus(); }}>
                        Clear search
                      </button>
                    )}
                    {filter !== "All" && (
                      <button onClick={() => { setFilter("All"); setSelId(null); searchRef.current?.focus(); }}>
                        {query ? "Search all types" : "Show all clips"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <div className="preview">{renderPreview()}</div>
        {settingsOpen && renderSettings()}
      </div>

      {!expanded && items.length > 0 && (
        <div className="foot">
          <span><kbd>↵</kbd> Copy &amp; close</span>
          <span><kbd>→</kbd> Preview</span>
          <span><kbd>⌘P</kbd> Pin</span>
          <span><kbd>⌘1–9</kbd> Quick copy</span>
        </div>
      )}

      <div className={`toast ${toast ? "show" : ""}`}>
        <span className="check">✓</span>
        <span>{toast}</span>
      </div>
    </div>
    </div>
    {tip && (
      <div
        className={`row-tip ${tip.place}`}
        style={{ top: tip.top, left: tip.left }}
      >
        {tip.text}
      </div>
    )}
    </>
  );
}
