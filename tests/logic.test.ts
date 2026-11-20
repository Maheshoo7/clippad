import { describe, expect, it } from "vitest";
import { classify } from "../src/lib/detect";
import { MAX_IMAGES, firstLine, trimItems } from "../src/App";
import { relativeTime } from "../src/lib/time";
import type { ClipItem } from "../src/types";

const item = (over: Partial<ClipItem>): ClipItem => ({
  id: Math.random().toString(36).slice(2),
  type: "text",
  text: "x",
  pinned: false,
  copiedAt: Date.now(),
  ...over,
});

describe("classify", () => {
  it("detects links", () => {
    expect(classify("https://example.com/a?b=1")).toBe("link");
    expect(classify("www.example.com")).toBe("link");
    expect(classify("  https://example.com  ")).toBe("link");
  });
  it("does not call prose with a URL inside a sentence a link", () => {
    expect(classify("see https://example.com for details")).toBe("text");
  });
  it("detects code", () => {
    expect(classify("const x = () => {\n  return 1;\n};")).toBe("code");
    expect(classify("SELECT id FROM users WHERE age > 21;")).toBe("code");
    expect(classify("def foo(self):\n    print(self.x)")).toBe("code");
  });
  it("treats plain prose as text", () => {
    expect(classify("Pick up milk and eggs")).toBe("text");
    expect(classify("The class starts at 9am, don't be late")).toBe("text");
  });
});

describe("trimItems", () => {
  it("keeps newest N unpinned items", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      item({ id: `i${i}`, copiedAt: 1000 + i }),
    );
    const out = trimItems(items, 3);
    expect(out.map((i) => i.id).sort()).toEqual(["i7", "i8", "i9"]);
  });
  it("never evicts pinned items", () => {
    const items = [
      item({ id: "old-pin", pinned: true, copiedAt: 1 }),
      ...Array.from({ length: 5 }, (_, i) => item({ id: `i${i}`, copiedAt: 100 + i })),
    ];
    const out = trimItems(items, 2);
    expect(out.find((i) => i.id === "old-pin")).toBeTruthy();
    expect(out.filter((i) => !i.pinned)).toHaveLength(2);
  });
  it("0 means unlimited", () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ id: `i${i}` }));
    expect(trimItems(items, 0)).toHaveLength(50);
  });
  it("keeps only the newest unpinned images, like the native store", () => {
    const items = [
      item({ id: "pinned-img", type: "image", pinned: true, copiedAt: 0 }),
      ...Array.from({ length: MAX_IMAGES + 3 }, (_, i) =>
        item({ id: `img${i}`, type: "image", copiedAt: 100 + i }),
      ),
      item({ id: "txt", copiedAt: 1 }),
    ];
    const out = trimItems(items, 0);
    expect(out.filter((i) => i.type === "image" && !i.pinned)).toHaveLength(MAX_IMAGES);
    expect(out.map((i) => i.id)).not.toContain("img0");
    expect(out.map((i) => i.id)).toEqual(expect.arrayContaining(["pinned-img", "txt"]));
  });
});

describe("relativeTime", () => {
  it("renders sane buckets", () => {
    const now = Date.now();
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 90_000, now)).toBe("1m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("Yesterday");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });
});

describe("firstLine", () => {
  it("skips leading blank lines so rows are never empty", () => {
    expect(firstLine("\n\n● Running 1 shell command\nmore")).toBe("● Running 1 shell command");
    expect(firstLine("   indented code\n  x")).toBe("indented code");
    expect(firstLine("single")).toBe("single");
    expect(firstLine(" ")).toBe("·");
    expect(firstLine("\n")).toBe("↵");
    expect(firstLine(" \t\n")).toBe("·→↵");
  });
});
