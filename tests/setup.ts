import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// ---- jsdom gaps ----

// matchMedia (theme resolution)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, // light by default
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })),
});

// scrollIntoView (list selection)
Element.prototype.scrollIntoView = vi.fn();

// canvas (image data-URL conversion)
// @ts-expect-error partial stub
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  putImageData: vi.fn(),
  drawImage: vi.fn(),
}));
HTMLCanvasElement.prototype.toDataURL = vi.fn(
  () => "data:image/png;base64,CANVASPNG",
);

// ImageData used by rgbaToDataUrl
if (!("ImageData" in globalThis)) {
  // @ts-expect-error test stub
  globalThis.ImageData = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      this.data = data;
      this.width = w;
      this.height = h;
    }
  };
}

// async clipboard (browser-mode copy path)
Object.defineProperty(navigator, "clipboard", {
  writable: true,
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
});
