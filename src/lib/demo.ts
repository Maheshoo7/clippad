import type { StoredItem } from "./history";

/**
 * Sample history for UI work in a plain browser: `npm run dev`, then open
 * http://localhost:1420/?demo. Dev builds only — never bundled into the app.
 */
export const isDemo =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");

const MIN = 60_000;

/** A small gradient swatch, so the image row has something to show. */
function swatch(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#7cc4a0"/><stop offset="1" stop-color="#2f7a5a"/>` +
    `</linearGradient></defs><rect width="320" height="200" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export function demoHistory(now = Date.now()): StoredItem[] {
  const rows: Omit<StoredItem, "id">[] = [
    { kind: "text", text: "Meet at the corner café at 4 — I'll bring the sketches.", pinned: false, copiedAt: now - 1 * MIN },
    { kind: "text", text: "https://github.com/Maheshoo7/clippad", pinned: false, copiedAt: now - 4 * MIN },
    {
      kind: "text",
      text: "const greet = (name: string) => {\n  return `Hello, ${name}!`;\n};",
      pinned: false,
      copiedAt: now - 9 * MIN,
    },
    { kind: "image", text: "Image 320×200", dataUrl: swatch(), width: 320, height: 200, pinned: false, copiedAt: now - 22 * MIN },
    { kind: "text", text: "Order #48213 — ships Thursday", pinned: false, copiedAt: now - 47 * MIN },
    { kind: "file", text: "/Users/you/Documents/launch-notes.md", pinned: false, copiedAt: now - 95 * MIN },
    { kind: "text", text: "git commit -m \"Make the cat purr on copy\"", pinned: false, copiedAt: now - 3 * 60 * MIN },
    { kind: "text", text: "221B Baker Street, London NW1 6XE", pinned: true, copiedAt: now - 2 * 24 * 60 * MIN },
    { kind: "text", text: "Thanks so much — talk soon!", pinned: true, copiedAt: now - 5 * 24 * 60 * MIN },
  ];
  return rows.map((r, i) => ({ id: `demo-${i}`, ...r }));
}
