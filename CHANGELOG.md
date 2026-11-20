# Changelog

All notable changes to ClipPad are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-21

The first public release. 🎉

### Added

- Clipboard history for text, links, code, images and Finder files, captured natively every 250 ms and saved straight to a local SQLite database.
- Global shortcut <kbd>⌘⇧V</kbd> and a menu-bar icon that open a floating panel on the screen you're using.
- Type-to-search, filters (Text, Links, Images, Code, Pinned), preview pane, pins, quick copy with <kbd>⌘1</kbd>–<kbd>⌘9</kbd>, and delete.
- De-duplication: copying something again moves it back to the top.
- Settings for appearance, history limit, image capture, launch at login and clearing history.
- Launch at login through macOS Login Items (macOS 13+).
- An animated menu-bar cat that reacts to copies, and a cat that lives on the panel.
- Light and dark themes.
- Strict Content Security Policy and least-privilege permissions for the interface.

[Unreleased]: https://github.com/Maheshoo7/clippad/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Maheshoo7/clippad/releases/tag/v0.1.0
