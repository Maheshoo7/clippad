//! Durable clipboard history (SQLite).
//!
//! One row per clip in a SQLite
//! database (WAL journal), inserted and committed synchronously by the
//! capture path, with trimming done in the same transaction. A copy is on
//! disk before the UI is even told about it, so a throttled webview, a
//! quit, or a crash can no longer lose it.
//!
//! The previous design kept history in the webview and periodically
//! rewrote one JSON file in place (tauri-plugin-store): items waited in
//! memory behind a debounce timer that WebKit throttles while hidden, and a
//! crash mid-write left a truncated file that loaded as an empty history —
//! which the next save then made permanent.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

/// Unpinned images kept (they dominate disk and IPC size).
pub const MAX_STORED_IMAGES: i64 = 30;
pub const DEFAULT_LIMIT: i64 = 500;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS clips (
    id        TEXT PRIMARY KEY,
    kind      TEXT NOT NULL CHECK (kind IN ('text', 'file', 'image')),
    text      TEXT NOT NULL,
    png       BLOB,
    width     INTEGER,
    height    INTEGER,
    pinned    INTEGER NOT NULL DEFAULT 0,
    copied_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clips_text ON clips (text);
CREATE INDEX IF NOT EXISTS clips_copied_at ON clips (copied_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

/// Something just captured from the clipboard, not yet stored.
#[derive(Debug, Clone, PartialEq)]
pub enum NewClip {
    Text(String),
    /// A file copied in Finder that isn't (or couldn't be read as) an image.
    File(String),
    Image {
        label: String,
        png: Vec<u8>,
        width: u32,
        height: u32,
    },
}

/// A stored clip as the frontend sees it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    pub id: String,
    /// "text" | "file" | "image" — the UI derives link/code from text.
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub pinned: bool,
    pub copied_at: i64,
    /// App that was in front when this was copied ("Slack"), if known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Listing {
    pub items: Vec<StoredItem>,
    pub version: u64,
}

/// Raw row for copying back to the clipboard.
pub struct ClipContent {
    pub kind: String,
    pub text: String,
    pub png: Option<Vec<u8>>,
}

pub type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{nanos:x}-{:x}", SEQ.fetch_add(1, Ordering::Relaxed))
}

pub struct History {
    conn: Mutex<Connection>,
    /// Bumped on every change, so the UI can tell whether it missed one.
    version: AtomicU64,
}

impl History {
    /// Open (or create) the database. A file SQLite can't use is moved
    /// aside — never overwritten — and a fresh one is started; if even that
    /// fails, history is kept in memory for this run.
    pub fn open_or_recover(path: &Path) -> Self {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match Self::open(path) {
            Ok(h) => return h,
            Err(e) => eprintln!("history database unusable ({e}); starting a new one"),
        }
        let aside = path.with_extension(format!("corrupt-{}.sqlite", now_ms()));
        let _ = std::fs::rename(path, &aside);
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{suffix}", path.display()));
            let _ = std::fs::rename(&side, format!("{}{suffix}", aside.display()));
        }
        Self::open(path).unwrap_or_else(|e| {
            eprintln!("history database still unusable ({e}); keeping history in memory");
            Self::in_memory()
        })
    }

    fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(err)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(err)?;
        // NORMAL + WAL: an app crash never loses a committed clip; only a
        // power cut can drop the last moment of writes, never corrupt.
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(err)?;
        conn.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(err)?;
        Self::init(conn)
    }

    pub fn in_memory() -> Self {
        Self::init(Connection::open_in_memory().expect("in-memory sqlite"))
            .expect("in-memory schema")
    }

    fn init(conn: Connection) -> Result<Self> {
        let ok: String = conn
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(err)?;
        if ok != "ok" {
            return Err(format!("integrity check failed: {ok}"));
        }
        conn.execute_batch(SCHEMA).map_err(err)?;
        // v2: remember which app each clip came from
        let has_source: bool = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('clips') WHERE name = 'source'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(err)?
            > 0;
        if !has_source {
            conn.execute_batch("ALTER TABLE clips ADD COLUMN source TEXT")
                .map_err(err)?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
            version: AtomicU64::new(1),
        })
    }

    fn bump(&self) -> u64 {
        self.version.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    fn with_tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn.transaction().map_err(err)?;
        let out = f(&tx)?;
        tx.commit().map_err(err)?;
        Ok(out)
    }

    #[cfg(test)]
    pub fn limit(&self) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        get_limit(&conn)
    }

    /// Store a capture. Re-copying something already in history moves it
    /// to the top instead of adding a duplicate. Returns the stored item
    /// and the history version that includes it.
    #[cfg(test)] // the watcher records the source app: see add_from
    pub fn add(&self, clip: NewClip, at: i64) -> Result<(StoredItem, u64)> {
        self.add_from(clip, at, None)
    }

    /// `add`, recording the app it was copied from. Re-copying an existing
    /// clip updates its source to the latest app.
    pub fn add_from(
        &self,
        clip: NewClip,
        at: i64,
        source: Option<&str>,
    ) -> Result<(StoredItem, u64)> {
        let item = self.with_tx(|tx| {
            let existing: Option<String> = match &clip {
                NewClip::Text(t) | NewClip::File(t) => tx
                    .query_row(
                        "SELECT id FROM clips WHERE kind != 'image' AND text = ?1",
                        [t],
                        |r| r.get(0),
                    )
                    .optional(),
                NewClip::Image { png, .. } => tx
                    .query_row(
                        "SELECT id FROM clips WHERE kind = 'image' AND png = ?1",
                        [png],
                        |r| r.get(0),
                    )
                    .optional(),
            }
            .map_err(err)?;

            let id = match existing {
                Some(id) => {
                    tx.execute(
                        "UPDATE clips SET copied_at = max(copied_at, ?2),
                                          source = coalesce(?3, source) WHERE id = ?1",
                        params![id, at, source],
                    )
                    .map_err(err)?;
                    id
                }
                None => {
                    let id = new_id();
                    let (kind, text, png, w, h) = match clip {
                        NewClip::Text(t) => ("text", t, None, None, None),
                        NewClip::File(p) => ("file", p, None, None, None),
                        NewClip::Image { label, png, width, height } => {
                            ("image", label, Some(png), Some(width), Some(height))
                        }
                    };
                    tx.execute(
                        "INSERT INTO clips (id, kind, text, png, width, height, pinned, copied_at, source)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
                        params![id, kind, text, png, w, h, at, source],
                    )
                    .map_err(err)?;
                    id
                }
            };
            trim(tx, get_limit(tx))?;
            get_item(tx, &id)?.ok_or_else(|| "clip was trimmed immediately".to_string())
        })?;
        Ok((item, self.bump()))
    }

    pub fn list(&self) -> Result<Listing> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        // Read the version under the lock so it matches the rows.
        let version = self.version();
        let mut stmt = conn
            .prepare(&format!("{SELECT_ITEM} ORDER BY copied_at DESC"))
            .map_err(err)?;
        let items = stmt
            .query_map([], row_to_item)
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        Ok(Listing { items, version })
    }

    pub fn content(&self, id: &str) -> Result<Option<ClipContent>> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT kind, text, png FROM clips WHERE id = ?1",
            [id],
            |r| {
                Ok(ClipContent {
                    kind: r.get(0)?,
                    text: r.get(1)?,
                    png: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(err)
    }

    /// Mark an item as just used; returns (copied_at, version).
    pub fn touch(&self, id: &str, at: i64) -> Result<(i64, u64)> {
        self.with_tx(|tx| {
            tx.execute(
                "UPDATE clips SET copied_at = ?2 WHERE id = ?1",
                params![id, at],
            )
            .map_err(err)?;
            Ok(())
        })?;
        Ok((at, self.bump()))
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<u64> {
        self.with_tx(|tx| {
            tx.execute(
                "UPDATE clips SET pinned = ?2 WHERE id = ?1",
                params![id, pinned],
            )
            .map_err(err)?;
            // Unpinning can push the unpinned count over the limit.
            trim(tx, get_limit(tx))
        })?;
        Ok(self.bump())
    }

    pub fn delete(&self, id: &str) -> Result<u64> {
        self.with_tx(|tx| {
            tx.execute("DELETE FROM clips WHERE id = ?1", [id])
                .map_err(err)?;
            Ok(())
        })?;
        Ok(self.bump())
    }

    pub fn clear_unpinned(&self) -> Result<u64> {
        self.with_tx(|tx| {
            tx.execute("DELETE FROM clips WHERE pinned = 0", [])
                .map_err(err)?;
            Ok(())
        })?;
        Ok(self.bump())
    }

    /// Persist the limit (so captures before the UI loads honor it) and trim.
    pub fn set_limit(&self, limit: i64) -> Result<u64> {
        let limit = limit.max(0);
        self.with_tx(|tx| {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES ('limit', ?1)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [limit.to_string()],
            )
            .map_err(err)?;
            trim(tx, limit)
        })?;
        Ok(self.bump())
    }

    /// One-time import of the JSON history older builds wrote. The file is
    /// renamed afterwards (kept as a backup), so this runs once.
    pub fn import_legacy_json(&self, path: &Path) {
        let Ok(bytes) = std::fs::read(path) else {
            return;
        };
        let items = match serde_json::from_slice::<LegacyFile>(&bytes) {
            Ok(f) => f.items,
            Err(e) => {
                eprintln!("legacy history unreadable ({e}); leaving it in place");
                return;
            }
        };
        let res = self.with_tx(|tx| {
            for it in items {
                let (kind, png) = match it.kind.as_str() {
                    "image" => {
                        let Some(png) = it.data_url.as_deref().and_then(decode_data_url) else {
                            continue;
                        };
                        ("image", Some(png))
                    }
                    _ => ("text", None),
                };
                tx.execute(
                    "INSERT OR IGNORE INTO clips (id, kind, text, png, width, height, pinned, copied_at)
                     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
                     WHERE NOT EXISTS (
                         SELECT 1 FROM clips WHERE kind = ?2 AND
                         ((?2 = 'image' AND png = ?4) OR (?2 != 'image' AND text = ?3)))",
                    params![it.id, kind, it.text, png, it.width, it.height, it.pinned, it.copied_at],
                )
                .map_err(err)?;
            }
            trim(tx, get_limit(tx))
        });
        match res {
            Ok(()) => {
                let _ = std::fs::rename(path, path.with_extension("json.migrated"));
                self.bump();
            }
            Err(e) => eprintln!("legacy history import failed ({e}); will retry next launch"),
        }
    }
}

#[derive(Deserialize)]
struct LegacyFile {
    #[serde(default)]
    items: Vec<LegacyItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyItem {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    text: String,
    data_url: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(default)]
    pinned: bool,
    copied_at: i64,
}

fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    let b64 = url.split_once(',')?.1;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

const SELECT_ITEM: &str =
    "SELECT id, kind, text, png, width, height, pinned, copied_at, source FROM clips";

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<StoredItem> {
    let png: Option<Vec<u8>> = r.get(3)?;
    Ok(StoredItem {
        id: r.get(0)?,
        kind: r.get(1)?,
        text: r.get(2)?,
        data_url: png.map(|b| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(b)
            )
        }),
        width: r.get(4)?,
        height: r.get(5)?,
        pinned: r.get(6)?,
        copied_at: r.get(7)?,
        source: r.get(8)?,
    })
}

fn get_item(conn: &Connection, id: &str) -> Result<Option<StoredItem>> {
    conn.query_row(&format!("{SELECT_ITEM} WHERE id = ?1"), [id], row_to_item)
        .optional()
        .map_err(err)
}

fn get_limit(conn: &Connection) -> i64 {
    conn.query_row("SELECT value FROM meta WHERE key = 'limit'", [], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(DEFAULT_LIMIT)
}

/// Keep every pinned item, the newest `limit` unpinned ones (0 = no
/// limit), and at most MAX_STORED_IMAGES unpinned images. Mirrors
/// `trimItems` in App.tsx so memory and disk always agree.
fn trim(tx: &Connection, limit: i64) -> Result<()> {
    tx.execute(
        "DELETE FROM clips WHERE pinned = 0 AND kind = 'image' AND id NOT IN (
             SELECT id FROM clips WHERE pinned = 0 AND kind = 'image'
             ORDER BY copied_at DESC LIMIT ?1)",
        [MAX_STORED_IMAGES],
    )
    .map_err(err)?;
    if limit > 0 {
        tx.execute(
            "DELETE FROM clips WHERE pinned = 0 AND id NOT IN (
                 SELECT id FROM clips WHERE pinned = 0
                 ORDER BY copied_at DESC LIMIT ?1)",
            [limit],
        )
        .map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_and_updates_the_source_app() {
        let h = History::in_memory();
        let (a, _) = h
            .add_from(NewClip::Text("hi".into()), 1, Some("Slack"))
            .unwrap();
        assert_eq!(a.source.as_deref(), Some("Slack"));
        let (b, _) = h
            .add_from(NewClip::Text("hi".into()), 2, Some("Notes"))
            .unwrap();
        assert_eq!((b.id == a.id, b.source.as_deref()), (true, Some("Notes")));
        // Unknown source keeps the last known one
        let (c, _) = h.add(NewClip::Text("hi".into()), 3).unwrap();
        assert_eq!(c.source.as_deref(), Some("Notes"));
    }

    #[test]
    fn upgrades_a_database_without_the_source_column() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clips (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
               png BLOB, width INTEGER, height INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
               copied_at INTEGER NOT NULL);
             INSERT INTO clips VALUES ('old', 'text', 'kept', NULL, NULL, NULL, 0, 5);",
        )
        .unwrap();
        let h = History::init(conn).unwrap();
        let items = h.list().unwrap().items;
        assert_eq!(
            (items[0].text.as_str(), items[0].source.clone()),
            ("kept", None)
        );
    }

    fn text(s: &str) -> NewClip {
        NewClip::Text(s.into())
    }
    fn image(byte: u8) -> NewClip {
        NewClip::Image {
            label: "Image 1×1".into(),
            png: vec![byte; 8],
            width: 1,
            height: 1,
        }
    }
    fn texts(h: &History) -> Vec<String> {
        h.list()
            .unwrap()
            .items
            .into_iter()
            .map(|i| i.text)
            .collect()
    }

    #[test]
    fn stores_newest_first_and_dedupes_by_moving_to_top() {
        let h = History::in_memory();
        h.add(text("a"), 1).unwrap();
        h.add(text("b"), 2).unwrap();
        let (again, _) = h.add(text("a"), 3).unwrap();
        assert_eq!(texts(&h), ["a", "b"]);
        assert_eq!(again.copied_at, 3);
        assert_eq!(h.list().unwrap().items.len(), 2);
    }

    #[test]
    fn a_file_path_dedupes_with_identical_text() {
        let h = History::in_memory();
        h.add(text("/tmp/x"), 1).unwrap();
        h.add(NewClip::File("/tmp/x".into()), 2).unwrap();
        assert_eq!(h.list().unwrap().items.len(), 1);
    }

    #[test]
    fn images_dedupe_by_content_and_carry_a_data_url() {
        let h = History::in_memory();
        h.add(image(1), 1).unwrap();
        h.add(image(1), 2).unwrap();
        h.add(image(2), 3).unwrap();
        let items = h.list().unwrap().items;
        assert_eq!(items.len(), 2);
        assert!(items[0]
            .data_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(items[0].width, Some(1));
    }

    #[test]
    fn trims_unpinned_to_the_limit_but_keeps_pinned() {
        let h = History::in_memory();
        h.set_limit(2).unwrap();
        let (old, _) = h.add(text("old"), 1).unwrap();
        h.set_pinned(&old.id, true).unwrap();
        for (i, t) in ["a", "b", "c"].iter().enumerate() {
            h.add(text(t), 10 + i as i64).unwrap();
        }
        assert_eq!(texts(&h), ["c", "b", "old"]);
        // Limit survives in the database for the next launch
        assert_eq!(h.limit(), 2);
    }

    #[test]
    fn caps_unpinned_images() {
        let h = History::in_memory();
        for i in 0..(MAX_STORED_IMAGES as u8 + 5) {
            h.add(image(i), i as i64).unwrap();
        }
        assert_eq!(h.list().unwrap().items.len(), MAX_STORED_IMAGES as usize);
    }

    #[test]
    fn touch_pin_delete_and_clear() {
        let h = History::in_memory();
        let (a, _) = h.add(text("a"), 1).unwrap();
        let (b, _) = h.add(text("b"), 2).unwrap();
        h.touch(&a.id, 5).unwrap();
        assert_eq!(texts(&h), ["a", "b"]);
        h.set_pinned(&b.id, true).unwrap();
        h.clear_unpinned().unwrap();
        assert_eq!(texts(&h), ["b"]);
        h.delete(&b.id).unwrap();
        assert!(texts(&h).is_empty());
    }

    #[test]
    fn every_change_bumps_the_version() {
        let h = History::in_memory();
        let v0 = h.version();
        let (_, v1) = h.add(text("a"), 1).unwrap();
        assert_eq!(v1, v0 + 1);
        assert_eq!(h.list().unwrap().version, v1);
    }

    #[test]
    fn persists_across_reopen_and_recovers_from_garbage() {
        let dir = std::env::temp_dir().join(format!("clippad-test-{}", new_id()));
        let path = dir.join("history.sqlite");
        {
            let h = History::open_or_recover(&path);
            h.add(text("survives"), 1).unwrap();
        }
        assert_eq!(texts(&History::open_or_recover(&path)), ["survives"]);

        let bad = dir.join("bad.sqlite");
        std::fs::write(&bad, b"definitely not a database, just garbage bytes").unwrap();
        let h = History::open_or_recover(&bad);
        h.add(text("fresh"), 1).unwrap();
        assert_eq!(texts(&h), ["fresh"]);
        let moved_aside = std::fs::read_dir(&dir)
            .unwrap()
            .any(|e| e.unwrap().file_name().to_string_lossy().contains("corrupt"));
        assert!(moved_aside, "unusable file must be kept, not overwritten");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_legacy_json_once() {
        let dir = std::env::temp_dir().join(format!("clippad-legacy-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let json = dir.join("clippad-history.json");
        std::fs::write(
            &json,
            r#"{"items":[
                {"id":"x1","type":"code","text":"const a = 1;","pinned":true,"copiedAt":20},
                {"id":"x2","type":"image","text":"Image 1×1","dataUrl":"data:image/png;base64,AAAA","width":1,"height":1,"pinned":false,"copiedAt":10},
                {"id":"x3","type":"link","text":"https://a.b","pinned":false,"copiedAt":5}
            ]}"#,
        )
        .unwrap();
        let h = History::in_memory();
        h.import_legacy_json(&json);
        let items = h.list().unwrap().items;
        assert_eq!(items.len(), 3);
        assert!(items[0].pinned);
        assert_eq!(items[1].kind, "image");
        assert!(!json.exists());
        assert!(dir.join("clippad-history.json.migrated").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
