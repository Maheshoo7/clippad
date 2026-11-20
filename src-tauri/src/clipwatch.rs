//! Native clipboard watcher.
//!
//! Polling used to run in the webview, but WebKit throttles timers in
//! hidden pages: with the panel closed, polls drifted to minutes apart and
//! anything copied (and replaced) in between was lost. This watcher runs on
//! its own thread, detects every change via `NSPasteboard.changeCount`
//! (through clipboard-rs) and commits
//! each capture to the SQLite history (`store.rs`) *before* telling the
//! frontend. The UI is only a view: if it is throttled, asleep or not yet
//! loaded, nothing is lost; it catches up from the database.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use clipboard_rs::common::RustImage;
use clipboard_rs::{
    Clipboard, ClipboardContext, ClipboardHandler, ClipboardWatcher, ClipboardWatcherContext,
    ContentFormat, RustImageData,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{now_ms, History, NewClip, StoredItem};

const POLL: Duration = Duration::from_millis(250);
const MAX_IMAGE_PIXELS: u64 = 4096 * 4096;
const MAX_TEXT_LEN: usize = 500_000;
const MAX_FILES_PER_COPY: usize = 10;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// How long our own clipboard write stays expected.
const SELF_WRITE_WINDOW_MS: i64 = 2_000;
/// Apps write the pasteboard in two steps (clear, then set data). A read
/// landing in between sees the new changeCount but no content; the change
/// would then be skipped for good, so re-read briefly before giving up.
const EMPTY_RETRIES: u32 = 5;
const EMPTY_RETRY_DELAY: Duration = Duration::from_millis(40);

/// What was on the clipboard right after one change.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub files: Vec<String>,
    pub text: Option<String>,
    pub image: Option<(u32, u32, Vec<u8>)>, // width, height, PNG
}

/// Content ClipPad itself just put on the clipboard (re-copy from history).
struct SelfWrite {
    until: i64,
    /// `None` for an image.
    text: Option<String>,
}

pub struct WatchState {
    capture_images: AtomicBool,
    self_write: Mutex<Option<SelfWrite>>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            capture_images: AtomicBool::new(true),
            self_write: Mutex::new(None),
        }
    }
}

impl WatchState {
    fn expect_self_write(&self, text: Option<String>) {
        *self.self_write.lock().unwrap_or_else(|p| p.into_inner()) = Some(SelfWrite {
            until: now_ms() + SELF_WRITE_WINDOW_MS,
            text,
        });
    }

    /// Is this change our own write? Matched by content, so a real copy
    /// made in the same instant is still recorded (the old time-only window
    /// swallowed whatever change came next).
    fn is_self_write(&self, snap: &Snapshot) -> bool {
        let mut guard = self.self_write.lock().unwrap_or_else(|p| p.into_inner());
        let Some(w) = guard.as_ref() else {
            return false;
        };
        if now_ms() > w.until {
            *guard = None;
            return false;
        }
        let ours = match &w.text {
            Some(t) => snap.text.as_deref() == Some(t.as_str()),
            None => snap.image.is_some() && snap.files.is_empty(),
        };
        if ours {
            *guard = None;
        }
        ours
    }
}

/// Text that merely labels an accompanying image — its URL or file name
/// (e.g. browser "Copy Image"). Anything else (a spreadsheet cell, a
/// paragraph from a document that also offers a rendered picture) is the
/// real content and wins over the image.
fn is_image_label(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.contains(char::is_whitespace) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
        || lower.starts_with("data:image/")
        || [
            ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic",
        ]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn read_image(ctx: &ClipboardContext) -> Option<(u32, u32, Vec<u8>)> {
    let img = ctx.get_image().ok()?;
    let (width, height) = img.get_size();
    if width == 0 || height == 0 || (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return None;
    }
    let png = img.to_png().ok()?;
    Some((width, height, png.get_bytes().to_vec()))
}

fn snapshot(capture_images: bool) -> Option<Snapshot> {
    // Everything is recorded — including password-manager copies flagged
    // concealed/transient; users delete what they don't want kept.
    let ctx = ClipboardContext::new().ok()?;
    let files = ctx.get_files().unwrap_or_default();
    let text = ctx.get_text().ok().filter(|t| !t.is_empty());
    let image = if files.is_empty()
        && capture_images
        && ctx.has(ContentFormat::Image)
        && text.as_deref().is_none_or(is_image_label)
    {
        read_image(&ctx)
    } else {
        None
    };
    if files.is_empty() && text.is_none() && image.is_none() {
        return None;
    }
    Some(Snapshot { files, text, image })
}

fn snapshot_settled(capture_images: bool) -> Option<Snapshot> {
    for attempt in 0..=EMPTY_RETRIES {
        if let Some(s) = snapshot(capture_images) {
            return Some(s);
        }
        if attempt < EMPTY_RETRIES {
            std::thread::sleep(EMPTY_RETRY_DELAY);
        }
    }
    None
}

/// `file:///a%20b.png` → `/a b.png`
fn file_url_to_path(f: &str) -> String {
    let Some(rest) = f.strip_prefix("file://") else {
        return f.to_string();
    };
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| rest.to_string())
}

fn is_image_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|e| lower.ends_with(e))
}

/// Load an image file's real contents as PNG.
fn image_file(path: &str) -> Option<NewClip> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?;
    let is_png = reader.format() == Some(image::ImageFormat::Png);
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 || (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return None;
    }
    // PNGs are stored as-is; anything else is normalized to PNG so
    // re-copying it can always be decoded.
    let png = if is_png {
        bytes
    } else {
        let img = image::load_from_memory(&bytes).ok()?;
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).ok()?;
        out.into_inner()
    };
    let label = path.rsplit(['/', '\\']).next().unwrap_or(path).to_string();
    Some(NewClip::Image {
        label,
        png,
        width,
        height,
    })
}

/// Turn one snapshot into the clips to store (oldest first).
pub fn to_clips(snap: Snapshot, capture_images: bool) -> Vec<NewClip> {
    // Files first (copied in Finder). The OS also puts the file's NAME
    // (text) and ICON (image) on the clipboard — both are decoys; capture
    // the real file contents instead.
    if !snap.files.is_empty() {
        return snap
            .files
            .iter()
            .take(MAX_FILES_PER_COPY)
            .map(|f| {
                let path = file_url_to_path(f);
                let img = if capture_images && is_image_file(&path) {
                    image_file(&path)
                } else {
                    None
                };
                img.unwrap_or(NewClip::File(path))
            })
            .collect();
    }
    if let Some((width, height, png)) = snap.image.filter(|_| capture_images) {
        let label = format!("Image {width}×{height}");
        return vec![NewClip::Image {
            label,
            png,
            width,
            height,
        }];
    }
    match snap.text {
        // Whitespace-only copies (a stray space or newline) aren't worth keeping
        Some(t) if !t.trim().is_empty() && t.len() <= MAX_TEXT_LEN => vec![NewClip::Text(t)],
        _ => vec![],
    }
}

#[derive(Serialize, Clone)]
struct Changed {
    item: StoredItem,
    version: u64,
}

struct Handler {
    app: AppHandle,
}

impl ClipboardHandler for Handler {
    fn on_clipboard_change(&mut self) {
        let watch = self.app.state::<WatchState>();
        let capture_images = watch.capture_images.load(Ordering::Relaxed);
        let Some(snap) = snapshot_settled(capture_images) else {
            return;
        };
        if watch.is_self_write(&snap) {
            return; // our own re-copy; history_copy already moved it to the top
        }
        let history = self.app.state::<History>();
        let at = now_ms();
        let source = frontmost_app();
        let mut saved = false;
        for (i, clip) in to_clips(snap, capture_images).into_iter().enumerate() {
            match history.add_from(clip, at + i as i64, source.as_deref()) {
                Ok((item, version)) => {
                    let _ = self
                        .app
                        .emit("clipboard-changed", Changed { item, version });
                    saved = true;
                }
                Err(e) => eprintln!("could not save clipboard item: {e}"),
            }
        }
        if saved {
            crate::traypet::poke(&self.app, crate::traypet::Pet::Copied);
        }
    }
}

/// Name of the app in front (e.g. "Slack") — where a copy almost always
/// comes from, since you copy in the app you're using.
fn frontmost_app() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2_foundation::NSString;
        // SAFETY: plain AppKit getters; NSWorkspace is safe to query from
        // any thread. Each returned object is checked for nil before use.
        unsafe {
            let cls = AnyClass::get(c"NSWorkspace")?;
            let ws: *mut AnyObject = msg_send![cls, sharedWorkspace];
            let app: *mut AnyObject = msg_send![ws.as_ref()?, frontmostApplication];
            let name: *mut NSString = msg_send![app.as_ref()?, localizedName];
            let name = name.as_ref()?.to_string();
            (!name.is_empty() && name != "ClipPad").then_some(name)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Start the watcher thread. Call once from `setup`, after `History` is managed.
pub fn start(app: &AppHandle) {
    app.manage(WatchState::default());
    keep_awake();
    let app = app.clone();
    std::thread::Builder::new()
        .name("clipboard-watch".into())
        .spawn(
            move || match ClipboardWatcherContext::new_with_interval(POLL) {
                Ok(mut watcher) => {
                    watcher.add_handler(Handler { app });
                    watcher.start_watch();
                }
                Err(e) => eprintln!("clipboard watcher failed to start: {e}"),
            },
        )
        .expect("spawn clipboard watcher");
}

/// Opt out of App Nap, which would otherwise throttle the watcher thread's
/// timer once the app has no visible windows (i.e. most of the time).
fn keep_awake() {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &NSString::from_str("Recording clipboard history"),
        );
        // Hold the activity for the life of the process.
        std::mem::forget(activity);
    }
}

#[tauri::command]
pub fn set_capture_images(state: tauri::State<'_, WatchState>, enabled: bool) {
    state.capture_images.store(enabled, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Copied {
    copied_at: i64,
    version: u64,
}

/// Put a history item back on the clipboard (the "paste" action) and move
/// it to the top. Done natively so the self-write mark is set right before
/// the write, with no IPC gap.
#[tauri::command]
pub fn history_copy(
    app: AppHandle,
    history: tauri::State<'_, History>,
    watch: tauri::State<'_, WatchState>,
    id: String,
) -> Result<Copied, String> {
    let item = history.content(&id)?.ok_or("item no longer exists")?;
    let ctx = ClipboardContext::new().map_err(|e| e.to_string())?;
    match item.png {
        Some(png) if item.kind == "image" => {
            let img = RustImageData::from_bytes(&png).map_err(|e| e.to_string())?;
            watch.expect_self_write(None);
            ctx.set_image(img).map_err(|e| e.to_string())?;
        }
        _ => {
            watch.expect_self_write(Some(item.text.clone()));
            ctx.set_text(item.text).map_err(|e| e.to_string())?;
        }
    }
    let (copied_at, version) = history.touch(&id, now_ms())?;
    crate::traypet::poke(&app, crate::traypet::Pet::CopiedBack);
    Ok(Copied { copied_at, version })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_urls_or_image_names() {
        assert!(is_image_label("https://example.com/cat.png"));
        assert!(is_image_label("My-Photo.JPG"));
        assert!(is_image_label("  file:///tmp/x  "));
        assert!(!is_image_label("42"));
        assert!(!is_image_label("Revenue Q3"));
        assert!(!is_image_label("hello world.png"));
        assert!(!is_image_label(""));
    }

    #[test]
    fn decodes_file_urls() {
        assert_eq!(
            file_url_to_path("file:///Users/me/My%20File.txt"),
            "/Users/me/My File.txt"
        );
        assert_eq!(file_url_to_path("/plain/path"), "/plain/path");
        assert_eq!(file_url_to_path("file:///odd%2"), "/odd%2");
    }

    fn snap(text: Option<&str>) -> Snapshot {
        Snapshot {
            text: text.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn keeps_text_but_skips_whitespace_and_oversized() {
        assert_eq!(
            to_clips(snap(Some("hi")), true),
            [NewClip::Text("hi".into())]
        );
        assert!(to_clips(snap(Some(" \n\t")), true).is_empty());
        assert!(to_clips(snap(Some(&"x".repeat(MAX_TEXT_LEN + 1))), true).is_empty());
    }

    #[test]
    fn images_win_unless_capture_is_off() {
        let s = || Snapshot {
            image: Some((2, 3, vec![1, 2])),
            ..Default::default()
        };
        assert!(matches!(
            &to_clips(s(), true)[..],
            [NewClip::Image {
                width: 2,
                height: 3,
                ..
            }]
        ));
        assert!(to_clips(s(), false).is_empty());
    }

    #[test]
    fn non_image_files_are_kept_as_paths() {
        let s = Snapshot {
            files: vec!["file:///tmp/a%20b.txt".into(), "/tmp/missing.png".into()],
            text: Some("a b.txt".into()),
            ..Default::default()
        };
        assert_eq!(
            to_clips(s, true),
            [
                NewClip::File("/tmp/a b.txt".into()),
                NewClip::File("/tmp/missing.png".into())
            ]
        );
    }

    #[test]
    fn reads_real_image_files() {
        let path = std::env::temp_dir().join(format!("clippad-{}.png", now_ms()));
        image::RgbaImage::new(3, 2).save(&path).unwrap();
        let s = Snapshot {
            files: vec![path.display().to_string()],
            ..Default::default()
        };
        let clips = to_clips(s, true);
        let _ = std::fs::remove_file(&path);
        assert!(matches!(
            &clips[..],
            [NewClip::Image {
                width: 3,
                height: 2,
                ..
            }]
        ));
    }

    #[test]
    fn self_writes_are_matched_by_content() {
        let w = WatchState::default();
        w.expect_self_write(Some("mine".into()));
        // A different copy in the window is a real copy, and doesn't consume the mark
        assert!(!w.is_self_write(&snap(Some("theirs"))));
        assert!(w.is_self_write(&snap(Some("mine"))));
        // Consumed: the same text copied again later is recorded
        assert!(!w.is_self_write(&snap(Some("mine"))));
    }
}
