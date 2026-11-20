import { isTauri } from "./history";

export const HOTKEY = "CommandOrControl+Shift+V";

// Compact window width: the panel (sized to fit the filter chips, see
// setCompactWidth) + 30px shadow room per side.
let COMPACT_W = 480;
const EXPANDED_W = 700;
const HEIGHT_RATIO = 0.8;
const MIN_H = 420;

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** A monitor's bounds in global logical points, plus its scale factor. */
interface Screen {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

function toScreen(m: {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
}): Screen {
  const s = m.scaleFactor;
  return {
    x: m.position.x / s,
    y: m.position.y / s,
    w: m.size.width / s,
    h: m.size.height / s,
    scale: s,
  };
}

/**
 * The monitor the mouse is on — i.e. where the user is working (and, for a
 * tray click, the screen whose menu bar was clicked). Not `currentMonitor()`:
 * that's wherever the hidden window last was, typically the laptop screen.
 */
async function screenAtCursor(): Promise<Screen | null> {
  const { availableMonitors, currentMonitor, primaryMonitor } = await import(
    "@tauri-apps/api/window"
  );
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const pt = await invoke<[number, number] | null>("cursor_point");
    if (pt) {
      const [cx, cy] = pt;
      const hit = (await availableMonitors())
        .map(toScreen)
        .find((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h);
      if (hit) return hit;
    }
  } catch (e) {
    console.error("cursor monitor lookup failed", e);
  }
  const mon = (await currentMonitor()) ?? (await primaryMonitor());
  return mon ? toScreen(mon) : null;
}

/** Target window height: ~80% of the screen's logical height. */
async function winHeight(screen?: Screen | null): Promise<number> {
  if (screen === undefined) {
    const { currentMonitor, primaryMonitor } = await import("@tauri-apps/api/window");
    const mon = (await currentMonitor()) ?? (await primaryMonitor());
    screen = mon ? toScreen(mon) : null;
  }
  if (!screen) return 534;
  return Math.max(MIN_H, Math.round(screen.h * HEIGHT_RATIO));
}

/** Show the overlay centered on the screen the mouse is on. */
export async function showOverlay(): Promise<void> {
  if (!isTauri) return;
  beforeExpand = null;
  document.body.classList.remove("anchored"); // centered: no popover arrow
  const w = await win();
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
  const screen = await screenAtCursor();
  const h = await winHeight(screen);
  await w.setSize(new LogicalSize(COMPACT_W, h));
  if (screen) {
    const left = screen.x + (screen.w - COMPACT_W) / 2;
    const top = screen.y + (screen.h - h) / 2;
    await w.setPosition(new LogicalPosition(Math.round(left), Math.round(top)));
  } else {
    await w.center();
  }
  await w.show();
  await w.setFocus();
}

/**
 * Size the compact window so the panel just fits its filter row. Called
 * by the UI after measuring; resizes in place if the panel is open.
 */
export async function setCompactWidth(windowW: number): Promise<void> {
  if (windowW === COMPACT_W) return;
  const old = COMPACT_W;
  COMPACT_W = windowW;
  if (!isTauri) return;
  const w = await win();
  if (!(await w.isVisible())) return;
  const scale = await w.scaleFactor();
  const size = await w.outerSize();
  if (Math.abs(size.width / scale - old) > 1) return; // expanded: leave it
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  await w.setSize(new LogicalSize(windowW, size.height / scale));
}

export async function hideOverlay(): Promise<void> {
  if (!isTauri) return;
  const w = await win();
  await w.hide();
}

export async function quitApp(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}

export async function toggleOverlay(): Promise<void> {
  if (!isTauri) return;
  const w = await win();
  if (await w.isVisible()) {
    await w.hide();
  } else {
    await showOverlay();
  }
}

interface TrayRect {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

// Transparent margin between window edge and the visible panel
const PAD = 30;
// Half the arrow's width (.tray-arrow in styles.css)
const ARROW_HALF = 14;
// Closest the arrow's centre may get to a panel side: its shoulders must
// clear the panel's 14px rounded corner
const ARROW_MIN = 14 + ARROW_HALF;
// How far from the panel's left edge the arrow ideally sits
const ARROW_INSET = ARROW_MIN;
// Arrow tip's offset from the window top (.tray-arrow `top` in styles.css)
const ARROW_TOP = 29;
// Space between the tray icon's bottom edge and the arrow tip
const ARROW_GAP = 2;

/** Toggle the overlay anchored just below the tray icon (physical coords). */
export async function toggleOverlayAt(rect: TrayRect): Promise<void> {
  if (!isTauri) return;
  beforeExpand = null;
  const w = await win();
  if (await w.isVisible()) {
    await w.hide();
    return;
  }
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
  // The clicked icon is on the screen under the mouse. Its rect is physical
  // pixels at *that* screen's scale, so convert with that scale — not the
  // window's, which reflects whichever screen the hidden window was last on.
  const screen = await screenAtCursor();
  const scale = screen?.scale ?? (await w.scaleFactor());
  const winW = COMPACT_W; // logical
  await w.setSize(new LogicalSize(winW, await winHeight(screen)));

  const iconCenter = (rect.position.x + rect.size.width / 2) / scale;
  const iconBottom = (rect.position.y + rect.size.height) / scale;

  // Panel opens to the right of the icon: panel's left edge just under it
  let left = iconCenter - PAD - ARROW_INSET;

  // Keep the visible panel on screen (tray icons live near the right edge)
  if (screen) {
    left = Math.min(left, screen.x + screen.w - (winW - PAD) - 8);
    left = Math.max(left, screen.x + 8 - PAD);
  }

  // Arrow tracks the icon even when the panel had to shift
  const arrowX = Math.min(Math.max(iconCenter - left, PAD + ARROW_MIN), winW - PAD - ARROW_MIN);
  document.documentElement.style.setProperty("--arrow-x", `${arrowX}px`);
  document.body.classList.add("anchored");

  // The panel sits BAND px below the window's top; that band holds the arrow
  // (tip at ARROW_TOP) and the cat walking on the panel's edge. Start
  // the window high enough that the arrow tip lands just under the icon,
  // like a native menu. The band overlaps the menu bar, which macOS allows
  // because the window is at status-bar level (float_above_menu_bar in
  // lib.rs); its empty part closes the panel when clicked (App.tsx).
  const wanted = iconBottom + ARROW_GAP - ARROW_TOP;
  const top = screen ? Math.max(screen.y, wanted) : Math.max(0, wanted);
  await w.setPosition(new LogicalPosition(Math.round(left), Math.round(top)));
  await w.show();
  await w.setFocus();
}

/**
 * Where the compact panel sat before the preview opened (and where the
 * arrow pointed), so closing the preview puts it back exactly — rather than
 * re-centering it, or leaving it wherever it had to shift to fit on screen.
 */
let beforeExpand: { left: number; top: number; arrowX: string } | null = null;

export async function setExpanded(expanded: boolean): Promise<void> {
  if (!isTauri) return;
  const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const w = await win();
  const scale = await w.scaleFactor();
  const pos = await w.outerPosition();
  const cur = { left: pos.x / scale, top: pos.y / scale };
  const height = (await w.outerSize()).height / scale;
  const root = document.documentElement.style;

  if (!expanded) {
    const back = beforeExpand;
    beforeExpand = null;
    await w.setSize(new LogicalSize(COMPACT_W, height));
    if (back) {
      if (back.arrowX) root.setProperty("--arrow-x", back.arrowX);
      await w.setPosition(new LogicalPosition(Math.round(back.left), Math.round(back.top)));
    }
    return;
  }

  if (!beforeExpand) beforeExpand = { ...cur, arrowX: root.getPropertyValue("--arrow-x") };
  const anchored = document.body.classList.contains("anchored");
  // Tray-anchored: grow to the right so the arrow stays on the icon.
  // Centered: grow evenly on both sides, so the panel stays centered.
  const wanted = anchored ? cur.left : cur.left - (EXPANDED_W - COMPACT_W) / 2;
  let left = wanted;
  const mon = await currentMonitor();
  if (mon) {
    const monLeft = mon.position.x / mon.scaleFactor;
    const monRight = monLeft + mon.size.width / mon.scaleFactor;
    const maxLeft = monRight - (EXPANDED_W - PAD) - 8;
    const minLeft = monLeft + 8 - PAD;
    left = Math.min(Math.max(wanted, minLeft), maxLeft);
  }
  if (anchored && left !== wanted) {
    // Had to shift to fit on screen: move the arrow so it still hits the icon
    const arrow = parseFloat(root.getPropertyValue("--arrow-x") || "0");
    if (arrow) {
      const arrowX = Math.min(Math.max(arrow + (wanted - left), PAD + ARROW_MIN), EXPANDED_W - PAD - ARROW_MIN);
      root.setProperty("--arrow-x", `${arrowX}px`);
    }
  }
  await w.setSize(new LogicalSize(EXPANDED_W, height));
  await w.setPosition(new LogicalPosition(Math.round(left), Math.round(cur.top)));
}

/** Register the global hotkey; safe to call repeatedly. */
export async function registerHotkey(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const gs = await import("@tauri-apps/plugin-global-shortcut");
    if (await gs.isRegistered(HOTKEY)) await gs.unregister(HOTKEY);
    await gs.register(HOTKEY, (event) => {
      if (event.state === "Pressed") void toggleOverlay();
    });
    return true;
  } catch (e) {
    console.error("hotkey registration failed", e);
    return false;
  }
}

/**
 * Hide the overlay whenever it loses focus ("invisible until summoned"),
 * and notify the app on both show and hide so it can reset UI state.
 */
export async function watchFocus(
  onChange: (focused: boolean) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const w = await win();
  return w.onFocusChanged(({ payload: focused }) => {
    if (!focused) void w.hide();
    onChange(focused);
  });
}
