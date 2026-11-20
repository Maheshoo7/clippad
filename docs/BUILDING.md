# Building ClipPad

This guide covers building ClipPad from source on macOS. To work on the code, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

```sh
xcode-select --install                                           # Xcode Command Line Tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  # Rust (skip if installed)
```

You also need [Node.js](https://nodejs.org) 20 or later.

Check that everything is in place:

```sh
node --version && rustc --version && cargo --version
```

## Build

```sh
git clone https://github.com/Maheshoo7/clippad.git
cd clippad
npm install
npm run tauri build
```

The first build compiles a few hundred Rust crates and takes 5–15 minutes. Later builds are incremental.

### Output

| Artifact | Path |
|---|---|
| App bundle | `src-tauri/target/release/bundle/macos/ClipPad.app` |
| DMG installer | `src-tauri/target/release/bundle/dmg/ClipPad_<version>_<arch>.dmg` |

To install, open the DMG and drag **ClipPad** into **Applications**. ClipPad is a menu-bar app with no Dock icon — open it with <kbd>⌘⇧V</kbd> or by clicking the cat in the menu bar.

## Universal binary (Apple Silicon + Intel)

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

## Code signing and notarisation

Unsigned builds run fine on the Mac that built them. Anyone else who downloads an unsigned build has to approve it once in **System Settings → Privacy & Security** (see the [README](../README.md#-install)).

To ship signed, notarised builds you need an Apple Developer ID certificate. Tauri reads these environment variables during `tauri build`:

| Variable | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | Base64 `.p12` certificate and its password (CI only) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarisation with an app-specific password |

See Tauri's [macOS code signing guide](https://v2.tauri.app/distribute/sign/macos/) for details. The release workflow passes these through when the matching repository secrets are set.

## App icon

The source artwork lives in [`assets/brand/`](../assets/brand). After changing it, regenerate every icon size with:

```sh
npx tauri icon assets/brand/app-icon.png
```

Menu-bar icons (`src-tauri/icons/tray/`) are separate monochrome template images used by the animated cat.

## Versioning

Bump the version in all three places, keeping them in sync:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## Troubleshooting

**`failed to read plugin permissions … No such file or directory`**
The build cache still points at an old folder location, which happens after you move or rename the project. Clear it and build again:

```sh
cargo clean --manifest-path src-tauri/Cargo.toml --release
```

**The shortcut does nothing after installing**
Another app may own <kbd>⌘⇧V</kbd>, or a dev build (`npm run tauri dev`) is still running and holding it. Quit the other copy.

**"ClipPad can't be opened because Apple cannot check it for malicious software"**
Expected for unsigned builds. Use **System Settings → Privacy & Security → Open Anyway**.
