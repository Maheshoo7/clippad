//! Sleepy Kitty — the animated menu-bar icon.
//!
//! The kitty dozes in the menu bar and reacts to what you do: it jolts
//! awake when something new is copied, opens its eyes while the panel is
//! up, follows ↑/↓ with its eyes, purrs when you copy an item back, winks
//! on pin, winces on delete, and yawns back to sleep when the panel closes.
//!
//! Runs natively on its own thread: the webview is hidden most of the time
//! and WebKit throttles timers in hidden pages, so frontend-driven frames
//! would stall exactly when a background copy should wake the kitty.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::{AppHandle, Manager};

#[path = "traypet_frames.rs"]
mod frames;

/// Must match `TRAY_ID` in src/lib/tray.ts (the tray is created there).
pub const TRAY_ID: &str = "clippad-tray";

const CLOSE_DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug)]
pub enum Pet {
    /// A new clip was captured from another app.
    Copied,
    /// The panel gained focus (hotkey, tray click).
    Open,
    /// The panel lost focus / was hidden.
    Close,
    /// An item was copied back from the history (Enter, click, ⌘1–9).
    CopiedBack,
    Pinned,
    Unpinned,
    Deleted,
    LookUp,
    LookDown,
    Typing,
}

pub struct PetState(Mutex<Sender<Pet>>);

type Seq = Vec<(&'static str, u64)>;

fn zzz() -> Seq {
    (0..12).map(|i| (ZZ[i], 140)).collect()
}
const ZZ: [&str; 12] = [
    "zz00", "zz01", "zz02", "zz03", "zz04", "zz05", "zz06", "zz07", "zz08", "zz09", "zz10", "zz11",
];
fn yawn() -> Seq {
    vec![
        ("yawn0", 200),
        ("yawn1", 300),
        ("yawn2", 450),
        ("yawn3", 250),
        ("sleep", 0),
    ]
}
fn wake() -> Seq {
    vec![("wake0", 160), ("wake1", 260)]
}
fn startle() -> Seq {
    let mut s: Seq = (0..6).map(|i| (JUMP[i], 90)).collect();
    s.push(("startle", 800));
    s
}
const JUMP: [&str; 6] = ["jump0", "jump1", "jump2", "jump3", "jump4", "jump5"];
fn happy() -> Seq {
    let mut s: Seq = (0..6).map(|i| (HAPPY[i], 100)).collect();
    s.push(("happy5", 500));
    s
}
const HAPPY: [&str; 6] = ["happy0", "happy1", "happy2", "happy3", "happy4", "happy5"];
fn awake_fidget(r: u64) -> Seq {
    if r.is_multiple_of(3) {
        vec![("tailL", 180), ("awake", 140), ("tailR", 180)]
    } else {
        vec![("blink", 150)]
    }
}

/// Tiny xorshift so idle timing doesn't look mechanical (no `rand` dep).
struct Rng(u64);
impl Rng {
    fn new() -> Self {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9);
        Rng(seed | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    /// Milliseconds in [lo, hi).
    fn ms(&mut self, lo: u64, hi: u64) -> Duration {
        Duration::from_millis(lo + self.next() % (hi - lo))
    }
}

/// Start the animation thread. Call once from `setup`.
pub fn start(app: &AppHandle) {
    let (tx, rx) = channel();
    app.manage(PetState(Mutex::new(tx)));
    let app = app.clone();
    std::thread::Builder::new()
        .name("tray-pet".into())
        .spawn(move || run(app, rx))
        .expect("spawn tray pet");
}

/// Send the kitty an event. Cheap and never blocks; ignored before `start`.
pub fn poke(app: &AppHandle, ev: Pet) {
    if let Some(state) = app.try_state::<PetState>() {
        if let Ok(tx) = state.0.lock() {
            let _ = tx.send(ev);
        }
    }
}

/// Frontend hook for reactions only the UI knows about (↑/↓, typing).
#[tauri::command]
pub fn tray_pet(app: AppHandle, event: String) {
    let ev = match event.as_str() {
        "look_up" => Pet::LookUp,
        "look_down" => Pet::LookDown,
        "typing" => Pet::Typing,
        _ => return,
    };
    poke(&app, ev);
}

fn run(app: AppHandle, rx: Receiver<Pet>) {
    let images: HashMap<&'static str, Image<'static>> = frames::FRAMES
        .iter()
        .filter_map(|(name, png)| match Image::from_bytes(png) {
            Ok(img) => Some((*name, img)),
            Err(e) => {
                eprintln!("tray frame {name} failed to decode: {e}");
                None
            }
        })
        .collect();

    let mut rng = Rng::new();
    let mut awake = false;
    let mut queue: VecDeque<(&'static str, u64)> = VecDeque::new();
    let mut shown: &'static str = "";
    // When the current frame's time is up (None = resting, nothing queued).
    let mut frame_end: Option<Instant> = None;
    let mut next_idle = Instant::now() + rng.ms(4000, 7000);
    // Focus can blip off and on while the panel is shown or re-anchored;
    // only treat it as closed if it stays closed for a moment.
    let mut pending_close: Option<Instant> = None;

    let show = |name: &'static str, shown: &mut &'static str| {
        if *shown == name {
            return;
        }
        let (Some(tray), Some(img)) = (app.tray_by_id(TRAY_ID), images.get(name)) else {
            return; // tray not created yet (frontend makes it); retry next frame
        };
        // Image + template flag in one main-thread call. `set_icon` alone
        // resets the template flag, so a frame would briefly render untinted
        // (black on a dark menu bar) before `set_icon_as_template` fixed it:
        // that was the flicker.
        if tray
            .set_icon_with_as_template(Some(img.clone()), true)
            .is_ok()
        {
            *shown = name;
        }
    };

    loop {
        let mut wake_at = frame_end.unwrap_or(next_idle);
        if let Some(close_at) = pending_close {
            wake_at = wake_at.min(close_at);
        }
        let mut handle = |ev: Pet, pending_close: &mut Option<Instant>| match ev {
            Pet::Close => {
                pending_close.get_or_insert(Instant::now() + CLOSE_DEBOUNCE);
                false
            }
            Pet::Open if pending_close.take().is_some() => false, // never really closed
            ev => react(ev, &mut awake, &mut queue),
        };
        let mut advance = match rx.recv_timeout(wake_at.saturating_duration_since(Instant::now())) {
            Ok(ev) => {
                let mut start = handle(ev, &mut pending_close);
                // Drain a burst (e.g. several clips at once) in one go
                while let Ok(ev) = rx.try_recv() {
                    start |= handle(ev, &mut pending_close);
                }
                start
            }
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let now = Instant::now();
        if pending_close.is_some_and(|at| now >= at) {
            pending_close = None;
            advance |= react(Pet::Close, &mut awake, &mut queue);
        }
        if !advance && frame_end.is_some_and(|end| now < end) {
            continue;
        }
        if let Some((name, ms)) = queue.pop_front() {
            show(name, &mut shown);
            frame_end = Some(now + Duration::from_millis(ms));
            continue;
        }
        frame_end = None;
        show(if awake { "awake" } else { "sleep" }, &mut shown);
        if now >= next_idle {
            queue.extend(if awake {
                awake_fidget(rng.next())
            } else {
                zzz()
            });
            next_idle = now
                + if awake {
                    rng.ms(2500, 5000)
                } else {
                    rng.ms(5000, 9000)
                };
            frame_end = Some(now); // start the idle sequence right away
        }
    }
}

/// Update state for an event. Returns true if the new frames should start
/// immediately (interrupting whatever is playing).
fn react(ev: Pet, awake: &mut bool, queue: &mut VecDeque<(&'static str, u64)>) -> bool {
    let interrupt = |queue: &mut VecDeque<_>, seq: Seq| {
        queue.clear();
        queue.extend(seq);
        true
    };
    match ev {
        Pet::Copied => {
            let mut seq = startle();
            if !*awake {
                // Look around for a moment, then doze off again
                seq.extend([("awake", 900), ("blink", 150), ("awake", 600)]);
                seq.extend(yawn());
            }
            interrupt(queue, seq)
        }
        Pet::Open => {
            if *awake {
                return false;
            }
            *awake = true;
            interrupt(queue, wake())
        }
        Pet::Close => {
            if !*awake {
                return false;
            }
            *awake = false;
            // Let a reaction (purr after copy-back, wince) finish first
            let start_now = queue.is_empty();
            queue.extend(yawn());
            start_now
        }
        Pet::CopiedBack => interrupt(queue, happy()),
        Pet::Pinned => interrupt(queue, vec![("wink", 700)]),
        Pet::Unpinned => interrupt(queue, vec![("blink", 150)]),
        Pet::Deleted => interrupt(queue, vec![("oops", 700)]),
        Pet::LookUp => interrupt(queue, vec![("up", 450)]),
        Pet::LookDown => interrupt(queue, vec![("down", 450)]),
        Pet::Typing => {
            if !queue.is_empty() {
                return false; // don't cut off a bigger reaction for a keystroke
            }
            interrupt(queue, vec![("down", 350)])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(q: &VecDeque<(&'static str, u64)>) -> Vec<&'static str> {
        q.iter().map(|(n, _)| *n).collect()
    }

    #[test]
    fn every_frame_used_in_a_sequence_exists() {
        let known: Vec<&str> = frames::FRAMES.iter().map(|(n, _)| *n).collect();
        let mut seqs = vec![
            zzz(),
            yawn(),
            wake(),
            startle(),
            happy(),
            awake_fidget(0),
            awake_fidget(1),
        ];
        seqs.push(vec![
            ("awake", 0),
            ("sleep", 0),
            ("wink", 0),
            ("oops", 0),
            ("up", 0),
            ("down", 0),
        ]);
        for (name, _) in seqs.into_iter().flatten() {
            assert!(known.contains(&name), "missing frame {name}");
        }
        for (name, png) in frames::FRAMES {
            assert!(Image::from_bytes(png).is_ok(), "{name} does not decode");
        }
    }

    #[test]
    fn a_copy_wakes_the_sleeping_kitty_then_it_dozes_off() {
        let (mut awake, mut q) = (false, VecDeque::new());
        assert!(react(Pet::Copied, &mut awake, &mut q));
        let seq = names(&q);
        assert_eq!(seq.first(), Some(&"jump0"));
        assert_eq!(seq.last(), Some(&"sleep"));
        assert!(!awake);
    }

    #[test]
    fn panel_open_close_and_purr_is_not_cut_off_by_close() {
        let (mut awake, mut q) = (false, VecDeque::new());
        react(Pet::Open, &mut awake, &mut q);
        assert!(awake);
        assert!(!react(Pet::Open, &mut awake, &mut q), "already awake");
        q.clear();
        react(Pet::CopiedBack, &mut awake, &mut q);
        // Copying hides the panel right away; the yawn queues after the purr
        assert!(!react(Pet::Close, &mut awake, &mut q));
        let seq = names(&q);
        assert_eq!(seq.first(), Some(&"happy0"));
        assert_eq!(seq.last(), Some(&"sleep"));
        assert!(!awake);
    }

    #[test]
    fn typing_never_interrupts_a_reaction() {
        let (mut awake, mut q) = (true, VecDeque::new());
        react(Pet::Pinned, &mut awake, &mut q);
        assert!(!react(Pet::Typing, &mut awake, &mut q));
        assert_eq!(names(&q), vec!["wink"]);
    }
}
