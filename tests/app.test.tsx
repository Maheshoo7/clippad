import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../src/App";

const fixtures = vi.hoisted(() => {
  const now = 1_800_000_000_000;
  return [
    { id: "t1", type: "text", text: "alpha note", pinned: false, copiedAt: now },
    { id: "t2", type: "link", text: "https://example.com", pinned: false, copiedAt: now - 1000 },
    { id: "t3", type: "code", text: "const x = 1;", pinned: false, copiedAt: now - 2000 },
    { id: "t4", type: "text", text: "beta memo", pinned: true, copiedAt: now - 3000 },
  ] as const;
});

vi.mock("../src/lib/history", () => ({
  isTauri: false,
  loadHistory: vi.fn(async () => fixtures.map((f) => ({ ...f }))),
  historyChanged: vi.fn(async () => false),
  setPinned: vi.fn(async () => {}),
  removeItem: vi.fn(async () => {}),
  clearUnpinned: vi.fn(async () => {}),
  setHistoryLimit: vi.fn(async () => {}),
}));

// Selected items render in BOTH the list row and the preview pane,
// so presence checks must tolerate multiple matches.
const seen = (t: string) => screen.queryAllByText(t).length > 0;

async function renderApp() {
  const utils = render(<App />);
  await screen.findAllByText("alpha note"); // wait for async load
  return utils;
}

const writeText = () => navigator.clipboard.writeText as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  writeText().mockClear();
});
afterEach(cleanup);

describe("list & search", () => {
  it("shows the Pinned section and item count", async () => {
    await renderApp();
    expect(document.querySelector(".section-label")?.textContent).toBe("Pinned");
    expect(seen("4 clips")).toBe(true);
  });

  it("filters as you type and Escape clears the query first", async () => {
    await renderApp();
    await userEvent.keyboard("alpha");
    expect(seen("alpha note")).toBe(true);
    expect(seen("beta memo")).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(seen("beta memo")).toBe(true);
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue("");
  });

  it("shows a no-matches state", async () => {
    await renderApp();
    await userEvent.keyboard("zzzzz");
    expect(screen.getByText(/No matches/)).toBeInTheDocument();
  });

  it("filter chips narrow by type", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(seen("https://example.com")).toBe(true);
    expect(seen("alpha note")).toBe(false);
  });
});

describe("preview", () => {
  it("→ opens the preview pane from the search box and ← closes it", async () => {
    await renderApp();
    const panel = document.querySelector(".panel")!;
    expect(panel.classList.contains("compact")).toBe(true);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(panel.classList.contains("compact")).toBe(false);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(panel.classList.contains("compact")).toBe(true);
  });

  it("→ moves the caret instead while it is inside the query", async () => {
    await renderApp();
    await userEvent.keyboard("alpha");
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    input.setSelectionRange(1, 1);
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(document.querySelector(".panel")!.classList.contains("compact")).toBe(true);
  });
});

describe("copying", () => {
  it("Enter copies the selected (newest) item", async () => {
    await renderApp();
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() => expect(writeText()).toHaveBeenCalledWith("alpha note"));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("ignores Enter during IME composition", async () => {
    await renderApp();
    fireEvent.keyDown(document, { key: "Enter", isComposing: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(writeText()).not.toHaveBeenCalled();
  });

  it("⌘2 quick-copies the second recent item", async () => {
    await renderApp();
    fireEvent.keyDown(document, { key: "2", metaKey: true });
    await waitFor(() =>
      expect(writeText()).toHaveBeenCalledWith("https://example.com"),
    );
  });

  it("plain digits type into search instead of pasting", async () => {
    await renderApp();
    await userEvent.keyboard("1");
    expect(writeText()).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue("1");
  });

  it("arrow keys move the selection", async () => {
    await renderApp();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    await waitFor(() =>
      expect(writeText()).toHaveBeenCalledWith("https://example.com"),
    );
  });
});

describe("pin & delete", () => {
  it("pins via the row hover button", async () => {
    await renderApp();
    const [pinBtn] = screen.getAllByTitle("Pin (⌘P)");
    fireEvent.click(pinBtn);
    await waitFor(() => expect(seen("Pinned")).toBe(true));
    expect(screen.getAllByTitle("Unpin (⌘P)").length).toBeGreaterThanOrEqual(2);
  });

  it("pinning copies the clip into Pinned and keeps it in the main list", async () => {
    await renderApp();
    const rowsWith = (text: string) =>
      Array.from(document.querySelectorAll(".list .row")).filter((r) => r.textContent?.includes(text));
    expect(rowsWith("alpha note")).toHaveLength(1);
    fireEvent.keyDown(document, { key: "p", metaKey: true }); // pin the newest ("alpha note")
    expect(rowsWith("alpha note")).toHaveLength(2);
    // still first in the main list
    expect(document.querySelector(".list .row")?.textContent).toContain("alpha note");
    // arrow keys step through every row, both copies included, to the end
    const rows = document.querySelectorAll(".list .row");
    expect(rows).toHaveLength(6); // 4 clips + 2 pinned copies
    for (let i = 0; i < 10; i++) fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.querySelector(".row.sel")).toBe(document.querySelectorAll(".list .row")[5]);
    expect(seen("4 clips")).toBe(true); // a pinned copy isn't counted twice
  });

  it("pins the selection with ⌘P", async () => {
    await renderApp();
    fireEvent.keyDown(document, { key: "p", metaKey: true });
    expect(screen.getAllByTitle("Unpin (⌘P)").length).toBeGreaterThanOrEqual(2);
  });

  it("deletes via the row hover button and ⌘⌫", async () => {
    await renderApp();
    const [delBtn] = screen.getAllByTitle("Delete (⌘⌫)");
    fireEvent.click(delBtn);
    expect(seen("alpha note")).toBe(false);

    fireEvent.keyDown(document, { key: "Backspace", metaKey: true });
    expect(seen("https://example.com")).toBe(false);
    expect(seen("2 clips")).toBe(true);
  });
});

describe("settings", () => {
  it("opens, closes with Escape, and doesn't leak keys to the list", async () => {
    await renderApp();
    fireEvent.click(screen.getByTitle("Settings"));
    expect(screen.getByText("Appearance")).toBeInTheDocument();

    // list navigation must be inert while settings are open
    fireEvent.keyDown(document, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(writeText()).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
    expect(seen("alpha note")).toBe(true); // panel content still there
  });

  it("closes when a filter chip is picked", async () => {
    await renderApp();
    fireEvent.click(screen.getByTitle("Settings"));
    expect(screen.getByText("Appearance")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
    expect(seen("const x = 1;")).toBe(true);
    expect(seen("alpha note")).toBe(false);
  });

  it("closes when the user types in search", async () => {
    await renderApp();
    fireEvent.click(screen.getByTitle("Settings"));
    expect(screen.getByText("Appearance")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("Search 4 clips"), "beta");
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
    expect(seen("beta memo")).toBe(true);
    expect(seen("alpha note")).toBe(false);
  });

  it("switches theme and persists it", async () => {
    await renderApp();
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => {
      expect(
        JSON.parse(localStorage.getItem("clippad-settings") ?? "{}").theme,
      ).toBe("dark");
    });
  });

  it("toggles image capture", async () => {
    await renderApp();
    fireEvent.click(screen.getByTitle("Settings"));
    const [sw] = screen.getAllByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("clear history requires confirmation and keeps pinned items", async () => {
    await renderApp();
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("button", { name: "Clear…" }));
    // Cancel first
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    // Then really clear
    fireEvent.click(screen.getByRole("button", { name: "Clear…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.keyDown(document, { key: "Escape" }); // close settings
    expect(seen("alpha note")).toBe(false);
    expect(seen("beta memo")).toBe(true); // pinned survives
  });
});
