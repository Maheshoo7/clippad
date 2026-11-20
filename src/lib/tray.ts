import { isTauri } from "./history";
import { showOverlay, toggleOverlayAt } from "./overlay";
import trayIconUrl from "../assets/tray.png";

// Must match TRAY_ID in src-tauri/src/traypet.rs, which animates this icon.
const TRAY_ID = "clippad-tray";
let creating = false;

let lastTyping = 0;

/**
 * Nudge the menu-bar kitty for UI-only actions (eyes follow ↑/↓, reads
 * along while you type). Copies, pins, deletes and panel open/close are
 * reported natively. Fire-and-forget.
 */
export function petReact(event: "look_up" | "look_down" | "typing"): void {
  if (!isTauri) return;
  if (event === "typing") {
    const now = Date.now();
    if (now - lastTyping < 700) return;
    lastTyping = now;
  }
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("tray_pet", { event }))
    .catch(() => {});
}

/**
 * Menu-bar / system-tray icon, created from the frontend. Starts as the
 * sleeping kitty; the native tray pet (traypet.rs) animates it from there.
 */
export async function initTray(): Promise<void> {
  if (!isTauri || creating) return;
  creating = true;
  try {
    const { TrayIcon } = await import("@tauri-apps/api/tray");
    if (await TrayIcon.getById(TRAY_ID)) return; // already exists (hot reload)

    const { Menu } = await import("@tauri-apps/api/menu");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");

    // Load the template icon bytes via the bundled asset URL
    const iconBytes = new Uint8Array(await (await fetch(trayIconUrl)).arrayBuffer());

    const menu = await Menu.new({
      items: [
        {
          id: "open",
          text: "Open ClipPad",
          accelerator: "CmdOrCtrl+Shift+V",
          action: () => void showOverlay(),
        },
        { item: "Separator" },
        {
          id: "quit",
          text: "Quit ClipPad",
          action: () => void getCurrentWindow().destroy(),
        },
      ],
    });

    await TrayIcon.new({
      id: TRAY_ID,
      icon: iconBytes,
      // Monochrome template: adapts to light/dark menu bar on macOS
      iconAsTemplate: true,
      tooltip: "ClipPad — ⌘⇧V",
      // Menu only on right-click; left-click opens the panel
      menu,
      showMenuOnLeftClick: false,
      action: (event) => {
        if (
          event.type === "Click" &&
          event.button === "Left" &&
          event.buttonState === "Up"
        ) {
          void toggleOverlayAt(event.rect);
        }
      },
    });
  } catch (e) {
    console.error("tray init failed", e);
    creating = false;
  }
}
