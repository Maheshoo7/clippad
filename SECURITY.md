# Security Policy

ClipPad sits next to some of the most sensitive data on a computer — whatever you copy. We take its security seriously and appreciate responsible reports.

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull requests.**

Report them privately through GitHub instead:

1. Go to the [**Security** tab](https://github.com/Maheshoo7/clippad/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and its impact.

You can expect:

- an acknowledgement within **3 working days**,
- an initial assessment within **7 days**,
- a fix or mitigation plan, coordinated with you, before anything is made public.

We're happy to credit you in the release notes unless you'd prefer to stay anonymous.

## Scope

In scope:

- the ClipPad app and its native code (`src-tauri/`),
- the user interface (`src/`) and its access to native commands,
- the release build and update process.

Examples of what we'd love to hear about:

- clipboard history being readable by, or sent to, anything other than the local user,
- ways for copied content to execute code or script inside the ClipPad interface,
- bypasses of the Content Security Policy or the app's [capabilities](src-tauri/capabilities/default.json),
- vulnerable dependencies that are actually reachable in ClipPad.

## How ClipPad protects your data

So you know what is and isn't a vulnerability:

- **No network.** ClipPad makes no network requests: no sync, no updates check, no analytics. The interface runs under a strict Content Security Policy.
- **Local storage.** History is kept in a SQLite database in `~/Library/Application Support/io.github.maheshoo7.clippad/`, readable only by your macOS user account.
- **Not encrypted at rest.** The database is not separately encrypted; it relies on macOS account permissions and FileVault. Software running as your user can read it, as it can your other files.
- **Everything is captured.** ClipPad records all clipboard changes, including content copied from password managers. Users can delete any clip or clear their history at any time.
- **Least privilege.** The interface can call only a small, fixed set of native commands; it can't read arbitrary files or run programs.

Changes to any of these are design decisions rather than vulnerabilities — feel free to open a regular feature request to discuss them.
