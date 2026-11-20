# Architecture

ClipPad is a [Tauri 2](https://tauri.app) app: a small **Rust** process that owns the clipboard and the history database, plus a **React/TypeScript** webview that draws the panel. This page explains how they fit together and why.

## The big picture

```
 ┌───────────────────────── Rust (src-tauri/) ─────────────────────────┐
 │                                                                     │
 │  clipwatch.rs ──► store.rs (SQLite, WAL) ──► "clipboard-changed"    │
 │  250 ms poll       insert · dedupe · trim         event ───────┐    │
 │       ▲                     ▲                                  │    │
 │       │ copy-back           │ list / pin / delete / clear      │    │
 │       │                     │                                  │    │
 │  traypet.rs  ◄── reacts to copies, focus, pins, deletes        │    │
 │  (menu-bar cat)                                                │    │
 └───────┼─────────────────────┼──────────────────────────────────┼────┘
         │      IPC commands   │                                  │
 ┌───────┼─────────────────────┼──── WebView (src/) ──────────────▼────┐
 │  lib/clipboard.ts      lib/history.ts            App.tsx            │
 │  copy-back             thin store client         panel UI           │
 └─────────────────────────────────────────────────────────────────────┘
```

**Rule of thumb:** the database is the source of truth and the webview is only a view. Anything that must not be lost happens in Rust.

## Why capture is native

macOS (WebKit) heavily throttles timers in hidden web pages, and ClipPad's panel is hidden almost all the time. An early version polled the clipboard from the webview and, with the panel closed, polls drifted to *minutes* apart — copies made in between were simply lost.

So capture lives in Rust:

1. **`clipwatch.rs`** runs on its own thread and checks `NSPasteboard.changeCount` every 250 ms (via [clipboard-rs](https://github.com/ChurchTao/clipboard-rs)) — the same approach long-standing Mac clipboard managers use.
2. On a change it reads files, image and text, ignoring empty, whitespace-only and oversized content, and re-reading briefly if an app is halfway through writing.
3. It commits the clip to SQLite **before** notifying the UI, then emits `clipboard-changed`.
4. ClipPad opts out of App Nap, so the watcher stays on schedule in the background (the Mac can still sleep normally).

When you copy a clip *back* from the panel, `history_copy` writes the clipboard natively and records the expected content, so the watcher recognises its own write and doesn't save it as a new clip.

## Storage

**`store.rs`** keeps one row per clip in `history.sqlite` (WAL journal) in the app data directory:

| Column | Meaning |
|---|---|
| `id` | Unique id |
| `kind` | `text`, `file` or `image` |
| `text` | The text, file path, or an image label |
| `png`, `width`, `height` | Image data (images only) |
| `pinned` | Pinned clips are never trimmed |
| `copied_at` | Unix time in milliseconds |

- **De-duplication:** copying an existing clip again moves it to the top instead of adding a duplicate.
- **Trimming:** the history limit (default 500, or unlimited) and the image cap (30 newest unpinned images) are enforced in the same transaction as the insert.
- **Versioning:** each change bumps a version number. The UI tracks it and reloads if it ever misses an event, so it can never drift from the database.
- **Recovery:** a corrupt database is set aside and a fresh one is created, rather than crashing at launch.

Link and code detection happen in the UI (`lib/detect.ts`), so the heuristics can improve without migrating stored data.

## The IPC contract

The webview can only call these commands (see `invoke_handler` in `lib.rs`):

| Command | Purpose |
|---|---|
| `history_list`, `history_version` | Read the history and its version |
| `history_set_pinned`, `history_delete`, `history_clear`, `history_set_limit` | Edit the history |
| `history_copy` | Put a clip back on the clipboard |
| `set_capture_images` | Turn image capture on or off |
| `tray_pet` | Tell the menu-bar cat about UI-only events (arrow keys, typing) |
| `cursor_point` | Find which screen the mouse is on (multi-monitor placement) |
| `login_item_status`, `set_login_item` | Launch at login |
| `quit_app` | Quit |

Plugin and window permissions are granted in [`src-tauri/capabilities/default.json`](../src-tauri/capabilities/default.json), and the webview runs under a strict Content Security Policy (`tauri.conf.json` → `app.security.csp`). There are no commands for reading arbitrary files, running programs or touching the network.

## Windows and placement

There's one window, `main`: a transparent, borderless panel that starts hidden. `lib/overlay.ts` handles showing, hiding and placing it:

- From the **shortcut** (<kbd>⌘⇧V</kbd>), the panel is centred on the screen the mouse is on.
- From the **menu-bar icon**, it hangs below the icon like a native popover, with a small arrow pointing up at it.

Tray click rectangles and monitor positions use different scale factors on mixed-DPI setups (say, a Retina laptop plus a non-Retina monitor), so placement looks up the screen under the mouse cursor rather than trusting either one. On macOS the window is raised to status-bar level so the popover can sit flush under the menu bar.

ClipPad runs as an *accessory* app — no Dock icon and no app menu.

## Launch at login

On macOS 13+ ClipPad registers itself with `SMAppService`, so it appears in **System Settings → General → Login Items**. Older systems fall back to a LaunchAgent via `tauri-plugin-autostart`. It's switched on once on first launch, and the user can turn it off at any time.

## The cats

There are two, and they're deliberately separate:

- **The menu-bar cat** (`traypet.rs`) is a native animation loop that swaps template tray icons from `src-tauri/icons/tray/`. It's native for the same reason capture is: a hidden webview can't animate reliably, yet a background copy should still wake the cat.
- **The panel cat** (`components/PadCat.tsx`) walks along the top edge of the panel using a sprite sheet rendered from the walk-cycle animation (`assets/cat/walk.json` → `src/assets/cat/walk.png`), with SVG poses for sitting and sleeping. It uses `requestAnimationFrame`, so it freezes while the panel is hidden and costs nothing.

Both respect *Reduce Motion*.

## Settings

UI preferences (theme, history limit, image capture, first-run flags) are stored with `tauri-plugin-store` in `clippad-settings.json`. The history limit is also stored in the database, so captures made before the UI loads still honour it.

## Testing

- **Frontend** — Vitest + Testing Library + jsdom in `tests/`, with the Tauri IPC mocked.
- **Rust** — unit tests next to the code (`cargo test`), covering the store, de-duplication, trimming and clipboard parsing.
- **CI** — every push and pull request runs type-checking, both test suites, `rustfmt` and `clippy` on macOS.
