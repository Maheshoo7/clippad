import { useEffect, useRef, useState } from "react";
import { CatSit, CatSleep } from "./catPoses";

/**
 * The cat lives on the panel's top edge. It wanders to a spot, stops,
 * sits for a while, sometimes curls up and sleeps, then wanders again.
 * The popover arrow (when the panel hangs from the menu-bar icon) is an
 * obstacle: the cat never walks through it, only turns around in front of it.
 *
 * The cat reacts to you:
 * - every click switches to the next action: sitting → walking → sleeping
 *   → (wakes with a little hop) sitting → …
 * - stroking it (moving the cursor over it) while it sits → purrs, hearts float up
 *
 * Walking uses the artist's Lottie walk cycle as a CSS sprite; the resting
 * poses are inline SVG. Movement is driven by requestAnimationFrame, which
 * the webview pauses while the panel is hidden — so the cat simply freezes and
 * carries on next time.
 */
type Mode = "walk" | "stand" | "sit" | "sleep";
type Fx = "none" | "purr" | "hop";

const CAT = 28; // px — on-screen size
const SPEED = 18; // px/s: matches the stride at this size and the 0.7s step cycle
const MIN_WALK = 40; // px — a click-started walk goes at least this far
const ARROW_HALF = 14; // half the popover arrow's width (see .tray-arrow)
const GAP = 4; // clearance the cat keeps from the arrow

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Actions {
  tap: () => void;
  pet: () => void;
}

export function PadCat() {
  const lane = useRef<HTMLDivElement>(null);
  const walker = useRef<HTMLDivElement>(null);
  const actions = useRef<Actions>({ tap: () => {}, pet: () => {} });
  const [mode, setMode] = useState<Mode>("sit");
  const [fx, setFx] = useState<Fx>("none");
  const [dir, setDir] = useState<1 | -1>(1);

  useEffect(() => {
    const s = {
      x: 0,
      target: 0,
      mode: "sit" as Mode,
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
      fxTimer: 0 as unknown as ReturnType<typeof setTimeout>,
      raf: 0,
      lastPet: 0,
    };
    const canAnimate = typeof requestAnimationFrame === "function";
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const place = () => {
      if (walker.current) walker.current.style.transform = `translateX(${s.x}px)`;
    };
    const set = (m: Mode) => {
      s.mode = m;
      setMode(m);
    };
    const later = (ms: number, fn: () => void) => {
      clearTimeout(s.timer);
      s.timer = setTimeout(fn, ms);
    };
    const flash = (f: Fx, ms: number) => {
      clearTimeout(s.fxTimer);
      setFx(f);
      s.fxTimer = setTimeout(() => setFx("none"), ms);
    };

    /** Where the cat may be: the lane, minus everything past the arrow. */
    const range = (): [number, number] => {
      const el = lane.current;
      if (!el) return [0, 0];
      const max = Math.max(0, el.clientWidth - CAT);
      if (!document.body.classList.contains("anchored")) return [0, max];
      const ax = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--arrow-x"));
      if (Number.isNaN(ax)) return [0, max];
      const a = ax - el.getBoundingClientRect().left; // arrow centre, lane coords
      const left: [number, number] = [0, a - ARROW_HALF - GAP - CAT];
      const right: [number, number] = [a + ARROW_HALF + GAP, max];
      const room = (r: [number, number]) => r[1] - r[0];
      let side = s.x + CAT / 2 < a ? left : right;
      if (room(side) < 0) side = room(left) > room(right) ? left : right;
      return [Math.max(0, side[0]), Math.max(0, side[0], Math.min(max, side[1]))];
    };

    const rest = () => {
      set("stand");
      later(rand(400, 900), sit);
    };
    const sit = (ms = rand(4000, 9000)) => {
      set("sit");
      later(ms, () => (Math.random() < 0.4 ? sleep() : wander()));
    };
    const sleep = () => {
      set("sleep");
      later(rand(10000, 22000), () => {
        set("sit"); // wake up, sit a moment, then wander
        later(rand(1500, 3000), wander);
      });
    };
    const wander = () => {
      const [lo, hi] = range();
      walkTo(rand(lo, hi));
    };
    const walkTo = (t: number) => {
      const [lo, hi] = range();
      s.target = Math.min(hi, Math.max(lo, t));
      if (Math.abs(s.target - s.x) < 8) return rest();
      clearTimeout(s.timer);
      setDir(s.target > s.x ? 1 : -1);
      set("walk");
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const d = s.target - s.x;
        const mv = Math.sign(d) * SPEED * dt;
        if (Math.abs(mv) >= Math.abs(d)) {
          s.x = s.target;
          place();
          rest();
          return;
        }
        s.x += mv;
        place();
        s.raf = requestAnimationFrame(step);
      };
      cancelAnimationFrame(s.raf);
      s.raf = requestAnimationFrame(step);
    };
    const stop = () => cancelAnimationFrame(s.raf);

    const purr = () => {
      flash("purr", 1600);
      sit(rand(5000, 9000)); // enjoys it: stays a while
    };
    /** Walk off somewhere at least MIN_WALK away (the far end if no room). */
    const walkOff = () => {
      const [lo, hi] = range();
      let t = rand(lo, hi);
      if (Math.abs(t - s.x) < MIN_WALK) t = s.x - lo > hi - s.x ? lo : hi;
      walkTo(t);
    };

    // Each click moves on to the next action: sit → walk → sleep → sit …
    actions.current.tap = () => {
      if (reduce || !canAnimate) return flash("purr", 1600);
      if (s.mode === "walk") {
        stop();
        sleep();
      } else if (s.mode === "sleep") {
        flash("hop", 450); // startled awake
        sit();
      } else {
        walkOff(); // sitting or standing
      }
    };
    // Stroking: moving the cursor over a sitting cat, at most every 2s
    actions.current.pet = () => {
      const now = Date.now();
      if (s.mode !== "sit" || now - s.lastPet < 2000) return;
      s.lastPet = now;
      purr();
    };

    // The arrow moves whenever the panel opens under a different icon
    // position: keep the cat on its side of it.
    const keepClear = () => {
      const [lo, hi] = range();
      if (s.x >= lo && s.x <= hi) return;
      stop();
      s.x = Math.min(hi, Math.max(lo, s.x));
      place();
      if (s.mode === "walk") rest();
    };

    const [lo, hi] = range();
    s.x = rand(lo, hi);
    place();
    if (reduce || !canAnimate) return; // The cat just sits
    later(rand(1500, 4000), wander);
    window.addEventListener("resize", keepClear);
    window.addEventListener("focus", keepClear);
    return () => {
      clearTimeout(s.timer);
      clearTimeout(s.fxTimer);
      stop();
      window.removeEventListener("resize", keepClear);
      window.removeEventListener("focus", keepClear);
    };
  }, []);

  return (
    <div className="cat-lane" ref={lane}>
      {/* Tints the white walk sprite to --cat-fur (#d4ecdd):
          multiplies each channel, so white → fur and black stays black */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <filter id="cat-tint" colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0.831 0 0 0 0  0 0.925 0 0 0  0 0 0.867 0 0  0 0 0 1 0"
          />
        </filter>
      </svg>
      <div
        className={`cat-walker ${fx !== "none" ? `fx-${fx}` : ""}`}
        ref={walker}
        role="button"
        aria-label="Cat"
        // keep focus in the search box while playing with the cat
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => actions.current.tap()}
        onMouseMove={() => actions.current.pet()}
      >
        <div
          className={`cat-body mode-${mode}`}
          style={dir < 0 ? { transform: "scaleX(-1)" } : undefined}
        >
          <div className="cat-sprite" />
          <CatSit className="cat-pose cat-sit" />
          <CatSleep className="cat-pose cat-sleep" />
        </div>
        {mode === "sleep" && (
          <div className={`cat-zs ${dir < 0 ? "flip" : ""}`}>
            <span>z</span>
            <span>z</span>
          </div>
        )}
        {fx === "purr" && (
          <div className="cat-hearts">
            <span>♥</span>
            <span>♥</span>
            <span>♥</span>
          </div>
        )}
      </div>
    </div>
  );
}
