# Contributing to ClipPad

First off — thank you! 🐈 Whether it's a typo fix, a bug report, a design idea or a whole feature, every contribution makes ClipPad better.

This guide gets you from zero to a running dev build in a few minutes, and explains how we work together.

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Making a change](#making-a-change)
- [Coding guidelines](#coding-guidelines)
- [Submitting a pull request](#submitting-a-pull-request)
- [Reporting bugs & requesting features](#reporting-bugs--requesting-features)

By taking part, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — something broken, confusing or slow? [Open a bug report](https://github.com/Maheshoo7/clippad/issues/new?template=bug_report.yml).
- **Suggest a feature** — check the [roadmap](README.md#-roadmap) and [open issues](https://github.com/Maheshoo7/clippad/issues) first, then [open a feature request](https://github.com/Maheshoo7/clippad/issues/new?template=feature_request.yml).
- **Pick up an issue** — issues labelled [`good first issue`](https://github.com/Maheshoo7/clippad/labels/good%20first%20issue) are small and well-scoped; [`help wanted`](https://github.com/Maheshoo7/clippad/labels/help%20wanted) are bigger. Comment on the issue so nobody duplicates your work.
- **Improve the docs** — clearer wording, better screenshots and translations are all valuable.
- **Bring ClipPad to Windows or Linux** — the biggest open opportunity. Start a discussion in an issue before diving in.

> [!IMPORTANT]
> Found a security vulnerability? Please **don't** open a public issue — follow [SECURITY.md](SECURITY.md) instead.

## Development setup

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| macOS | 10.15+ | — |
| Xcode Command Line Tools | latest | `xcode-select --install` |
| Node.js | 20+ (see [`.nvmrc`](.nvmrc)) | [nodejs.org](https://nodejs.org) or `nvm install` |
| Rust | stable | [rustup.rs](https://rustup.rs) |

### Get it running

```sh
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/clippad.git
cd clippad

# 2. Install JavaScript dependencies
npm install

# 3. Start the app with live reload
npm run tauri dev
```

The first run compiles a few hundred Rust crates and takes several minutes; after that, rebuilds are quick. The app starts **hidden** — look for the cat in your menu bar, or press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>V</kbd>.

> [!TIP]
> **Working on the UI only?** Run `npm run dev` and open <http://localhost:1420/?demo> in your browser. You get the full panel, filled with sample clips, with instant hot reload and browser dev tools — no Rust build needed. (Native features such as capture and the tray are inactive there.)

> [!NOTE]
> A dev build and an installed ClipPad share the same history database and the same <kbd>⌘</kbd><kbd>⇧</kbd><kbd>V</kbd> shortcut. Quit the installed app while developing to avoid confusion.

### Useful scripts

| Command | What it does |
|---|---|
| `npm run tauri dev` | Run the full app with live reload |
| `npm run dev` | Run only the web UI (use `/?demo` for sample data) |
| `npm test` | Run the frontend tests (Vitest) |
| `npm run test:rust` | Run the Rust tests |
| `npm run typecheck` | Type-check the TypeScript |
| `npm run lint:rust` | `rustfmt` check + `clippy` with warnings as errors |
| `npm run check` | **All of the above** — run this before opening a PR |
| `npm run tauri build` | Build a release `.app` and `.dmg` |

## Project structure

```
clippad/
├── src/                    # Frontend — React + TypeScript (the panel UI)
│   ├── App.tsx             # The panel: list, search, filters, settings, keyboard handling
│   ├── components/         # PadCat (the panel cat), cat poses, icons
│   ├── lib/                # Non-UI logic: history client, overlay window, tray, settings…
│   ├── assets/             # Images bundled into the UI
│   └── styles.css          # Design tokens and all styles (light + dark)
├── src-tauri/              # Native shell — Rust
│   ├── src/
│   │   ├── lib.rs          # App setup, plugin registration, IPC commands, login item
│   │   ├── clipwatch.rs    # Clipboard watcher (NSPasteboard, 250 ms poll)
│   │   ├── store.rs        # SQLite history: insert, de-duplicate, trim, pin, delete
│   │   └── traypet.rs      # The animated menu-bar cat
│   ├── capabilities/       # Tauri permissions granted to the UI (least privilege)
│   ├── icons/              # App and menu-bar icons (generated)
│   └── tauri.conf.json     # App config: window, CSP, bundle metadata
├── tests/                  # Frontend tests (Vitest + Testing Library)
├── assets/                 # Design sources: app icon SVG/PNG, cat animation
├── docs/                   # Building, architecture, screenshots
└── .github/                # CI, release workflow, issue & PR templates
```

For how the pieces fit together — capture, storage, the IPC contract and the tray cat — read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Making a change

1. **Open or find an issue first** for anything bigger than a small fix, so we can agree on the approach before you invest time.
2. **Create a branch** from `main`:
   ```sh
   git checkout -b fix/search-ignores-accents
   ```
   Prefixes we use: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`.
3. **Make your change**, with tests where it makes sense.
4. **Run the checks**: `npm run check`.
5. **Try it for real** with `npm run tauri dev` — especially for anything touching capture, the tray or windows.
6. **Commit** using [Conventional Commits](https://www.conventionalcommits.org):
   ```
   feat: add paste-as-plain-text with ⇧Enter
   fix(store): keep pinned images when trimming history
   docs: explain the browser demo mode
   ```

## Coding guidelines

ClipPad's guiding principles: **invisible until summoned · private by default · keyboard-first · fast**. New features should respect all four.

**General**
- Keep changes focused — one concern per pull request.
- Comment the *why*, not the *what*. Many modules start with a short note on design decisions; keep those up to date.
- No network access, telemetry or third-party services. ClipPad is local-only by design.

**TypeScript / React**
- Strict TypeScript; avoid `any`.
- Native calls go through `src/lib/` — components shouldn't call `invoke` directly.
- Every action must work from the keyboard and have an accessible label.
- Respect `prefers-reduced-motion` for anything animated.
- Use the design tokens in `styles.css` (`--accent`, `--surface-*`, `--r-*`…) rather than hard-coded colours, and check both light and dark themes.

**Rust**
- Code must pass `cargo fmt` and `cargo clippy -- -D warnings`.
- Return `Result` from commands instead of panicking; the release profile uses `panic = "abort"`.
- Every `unsafe` block needs a `// SAFETY:` comment explaining why it's sound.
- Keep the clipboard watcher and the database independent of the UI: a copy must be saved even if the webview is asleep.

**Security**
- If you add a Tauri command or plugin, grant the narrowest permission possible in `src-tauri/capabilities/`.
- Don't loosen the Content Security Policy in `tauri.conf.json` without discussing it in the PR.
- Use parameterised SQL only — never build queries from strings.

**Tests**
- Frontend: Vitest + Testing Library, in `tests/`. Native IPC is mocked — see `tests/watcher.test.ts`.
- Rust: unit tests sit next to the code in `#[cfg(test)]` modules.
- Bug fixes should come with a test that fails without the fix.

## Submitting a pull request

1. Push your branch and open a PR against `main`.
2. Fill in the PR template — what changed, why, and how you tested it. **Screenshots or a short screen recording** are a big help for UI changes.
3. Make sure CI is green.
4. A maintainer will review, usually within a few days. Please don't take change requests personally — we're all trying to make ClipPad great.
5. Once approved, we'll squash-merge your PR. 🎉

## Reporting bugs & requesting features

Good bug reports have:

- your macOS version and Mac model (Apple Silicon or Intel),
- the ClipPad version (shown in the release you downloaded),
- exact steps to reproduce, what you expected, and what happened instead,
- screenshots or a recording if it's visual.

> [!CAUTION]
> Your clipboard history can contain private data. **Never paste real clipboard contents, passwords or personal information** into an issue — make up an example instead.

## Releasing (maintainers)

1. Update the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Move the `Unreleased` notes in [CHANGELOG.md](CHANGELOG.md) under the new version and date.
3. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
4. The [Release workflow](.github/workflows/release.yml) builds Apple Silicon and Intel DMGs and creates a **draft** GitHub release. Review the notes and publish it.
5. The [Homebrew tap](https://github.com/Maheshoo7/homebrew-tap) picks up the published release within six hours. To update it straight away: `gh workflow run update-clippad.yml --repo Maheshoo7/homebrew-tap`.

---

Questions? Open an issue — there are no silly ones. Thanks again for helping! 💚
