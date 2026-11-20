import type { Settings, ThemePref } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { isTauri } from "./history";

const SETTINGS_KEY = "settings";
// First-run flag. Renamed from "autostartInitialized" when login items moved
// to SMAppService: earlier builds set that flag without leaving a working
// login item, so existing installs get the default applied once more.
const AUTOSTART_INIT_KEY = "loginItemInitialized";
const LS_KEY = "clippad-settings";
const LEGACY_THEME_KEY = "clippad-theme"; // pre-settings versions stored theme here

type StoreLike = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

let storePromise: Promise<StoreLike> | null = null;

async function getStore(): Promise<StoreLike> {
  if (!storePromise) {
    storePromise = import("@tauri-apps/plugin-store").then((m) =>
      m.load("clippad-settings.json", { autoSave: false, defaults: {} }),
    );
  }
  return storePromise;
}

function sanitize(raw: unknown): Settings {
  const s = (raw ?? {}) as Partial<Settings>;
  const theme: ThemePref =
    s.theme === "light" || s.theme === "dark" ? s.theme : "system";
  const historyLimit =
    typeof s.historyLimit === "number" && s.historyLimit >= 0
      ? Math.floor(s.historyLimit)
      : DEFAULT_SETTINGS.historyLimit;
  return {
    theme,
    historyLimit,
    captureImages: s.captureImages !== false,
  };
}

export async function loadSettings(): Promise<Settings> {
  // Migrate the old localStorage theme once, as a fallback default
  const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
  const legacy: Partial<Settings> =
    legacyTheme === "light" || legacyTheme === "dark" ? { theme: legacyTheme } : {};

  if (!isTauri) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return sanitize({ ...legacy, ...(raw ? JSON.parse(raw) : {}) });
    } catch {
      return sanitize(legacy);
    }
  }
  try {
    const store = await getStore();
    const saved = await store.get<Partial<Settings>>(SETTINGS_KEY);
    return sanitize({ ...legacy, ...saved });
  } catch (e) {
    console.error("loadSettings failed", e);
    return sanitize(legacy);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveSettings(settings: Settings): void {
  if (!isTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(settings));
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const store = await getStore();
      await store.set(SETTINGS_KEY, settings);
      await store.save();
    } catch (e) {
      console.error("saveSettings failed", e);
    }
  }, 250);
}

// ---- launch at login ----
// Backed by Rust commands: SMAppService on macOS 13+ (shows under System
// Settings → Login Items), tauri-plugin-autostart elsewhere.
// All calls degrade gracefully outside Tauri / on failure.

export type LoginItemStatus = "enabled" | "disabled" | "requires-approval";

async function loginItemStatus(): Promise<LoginItemStatus> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoginItemStatus>("login_item_status");
}

export async function getAutostart(): Promise<boolean | null> {
  if (!isTauri) return null;
  try {
    return (await loginItemStatus()) === "enabled";
  } catch {
    return null; // unavailable — hide the toggle
  }
}

/** Returns the resulting status, or null if the change failed. */
export async function setAutostart(enabled: boolean): Promise<LoginItemStatus | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<LoginItemStatus>("set_login_item", { enabled });
  } catch (e) {
    console.error("login item toggle failed", e);
    return null;
  }
}

/**
 * On the first run, enable launch-at-login by default (macOS shows its own
 * "Login Item Added" notification). Runs exactly once: a persisted flag
 * ensures that if the user later disables it, we never turn it back on.
 * Safe to call on every startup. Returns the effective state (or null if
 * unavailable / not in Tauri).
 */
export async function ensureAutostartDefault(): Promise<boolean | null> {
  if (!isTauri) return null;
  try {
    const store = await getStore();
    const alreadyInit = await store.get<boolean>(AUTOSTART_INIT_KEY);
    if (alreadyInit) return await getAutostart();

    const status = await setAutostart(true);
    // Record the flag even if enabling failed, so we don't nag on every launch.
    await store.set(AUTOSTART_INIT_KEY, true);
    await store.save();
    return status === null ? await getAutostart() : status === "enabled";
  } catch (e) {
    console.error("ensureAutostartDefault failed", e);
    return getAutostart();
  }
}
