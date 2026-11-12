//! Local database of engine evaluations of opening positions.
//!
//! The same opening positions come back in game reports, in the repertoire check and
//! in the statistics: each is analysed once and kept here (also with the evaluations
//! of the Lichess cloud, often much deeper). Positions are keyed by FEN without the
//! move counters, so transpositions and different move numbers meet.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use log::warn;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, EnPassantMode, Position,
};
use specta::Type;
use tauri::Manager;

use crate::error::Error;

/// Only positions up to this move number are kept (the opening).
pub const MAX_FULLMOVE: u32 = 20;
/// For analyses by time (not by depth), a stored evaluation is good from this depth.
pub const TIME_MODE_MIN_DEPTH: u32 = 20;

/// One line of an evaluation; the score is from White's point of view.
#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub struct CachedLine {
    pub uci_moves: Vec<String>,
    pub san_moves: Vec<String>,
    pub cp: Option<i32>,
    pub mate: Option<i32>,
    pub depth: u32,
    pub multipv: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "camelCase")]
pub struct CachedEval {
    pub depth: u32,
    pub lines: Vec<CachedLine>,
    /// "lichess" or the name of the local engine.
    pub source: String,
    /// The Lichess cloud was already asked about this position.
    pub lichess_checked: bool,
}

#[derive(Serialize, Clone, Debug, Type)]
pub struct EvalCacheStats {
    pub positions: u32,
    pub bytes: u32,
}

static DB: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::EvalCache(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| Error::EvalCache(e.to_string()))?;
    Ok(dir.join("evalcache.db3"))
}

fn with_db<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, Error> {
    let lock = DB.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|e| Error::EvalCache(e.to_string()))?;
    if guard.is_none() {
        let conn = Connection::open(db_path(app)?).map_err(|e| Error::EvalCache(e.to_string()))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS evals (
                 fen TEXT PRIMARY KEY,
                 depth INTEGER NOT NULL,
                 data TEXT NOT NULL,
                 source TEXT NOT NULL,
                 lichess_checked INTEGER NOT NULL DEFAULT 0,
                 updated INTEGER NOT NULL
             );",
        )
        .map_err(|e| Error::EvalCache(e.to_string()))?;
        *guard = Some(conn);
    }
    f(guard.as_ref().unwrap()).map_err(|e| Error::EvalCache(e.to_string()))
}

/// FEN without the move counters (and en passant only when it can be played).
pub fn position_key(pos: &Chess) -> String {
    let fen = Fen::from_position(pos, EnPassantMode::Legal).to_string();
    fen.split(' ').take(4).collect::<Vec<_>>().join(" ")
}

pub fn key_of_fen(fen: &str) -> Option<String> {
    let fen: Fen = fen.parse().ok()?;
    let setup = fen.as_setup().clone();
    let mode = CastlingMode::detect(&setup);
    let pos: Chess = setup.position(mode).ok()?;
    Some(position_key(&pos))
}

pub fn is_opening(pos: &Chess) -> bool {
    pos.fullmoves().get() <= MAX_FULLMOVE
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn get(app: &tauri::AppHandle, key: &str) -> Result<Option<CachedEval>, Error> {
    with_db(app, |db| {
        db.query_row(
            "SELECT data, lichess_checked FROM evals WHERE fen = ?1",
            params![key],
            |row| {
                let data: String = row.get(0)?;
                let checked: i64 = row.get(1)?;
                Ok((data, checked))
            },
        )
        .optional()
    })
    .map(|row| {
        row.and_then(|(data, checked)| {
            let mut eval: CachedEval = serde_json::from_str(&data).ok()?;
            eval.lichess_checked = checked != 0;
            Some(eval)
        })
    })
}

/// Stores `eval` unless a deeper one (with as many lines) is already there.
pub fn put(app: &tauri::AppHandle, key: &str, eval: &CachedEval) -> Result<(), Error> {
    if eval.lines.is_empty() {
        return Ok(());
    }
    let existing = get(app, key)?;
    if let Some(old) = &existing {
        if old.depth > eval.depth
            || (old.depth == eval.depth && old.lines.len() >= eval.lines.len())
        {
            return Ok(());
        }
    }
    let checked = eval.lichess_checked || existing.map(|e| e.lichess_checked).unwrap_or(false);
    let data = serde_json::to_string(eval).map_err(|e| Error::EvalCache(e.to_string()))?;
    with_db(app, |db| {
        db.execute(
            "INSERT INTO evals (fen, depth, data, source, lichess_checked, updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(fen) DO UPDATE SET depth = ?2, data = ?3, source = ?4,
                 lichess_checked = ?5, updated = ?6",
            params![key, eval.depth, data, eval.source, checked as i64, now()],
        )
        .map(|_| ())
    })
}

/// Remembers that the Lichess cloud was asked (also when it had nothing).
pub fn mark_lichess_checked(app: &tauri::AppHandle, key: &str) -> Result<(), Error> {
    with_db(app, |db| {
        db.execute(
            "UPDATE evals SET lichess_checked = 1 WHERE fen = ?1",
            params![key],
        )
        .map(|_| ())
    })
}

#[derive(Deserialize)]
struct CloudPv {
    moves: String,
    cp: Option<i32>,
    mate: Option<i32>,
}

#[derive(Deserialize)]
struct CloudEval {
    depth: u32,
    pvs: Vec<CloudPv>,
}

pub enum Cloud {
    Found(CachedEval),
    Missing,
    /// Too many requests (or no connection): stop asking for this run.
    Unavailable,
}

/// Until when (seconds since the epoch) Lichess is left alone after refusing or failing,
/// for every analysis: a batch of many games would otherwise ask again at each game.
static CLOUD_PAUSED_UNTIL: AtomicU64 = AtomicU64::new(0);
const CLOUD_PAUSE_SECS: u64 = 60;

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn pause_cloud() {
    CLOUD_PAUSED_UNTIL.store(now_secs() + CLOUD_PAUSE_SECS, AtomicOrdering::SeqCst);
}

/// Asks the Lichess cloud for the evaluation of a position (opening positions are
/// often there, analysed very deeply). Scores are from White's point of view.
pub async fn lichess_cloud(pos: &Chess, multipv: usize) -> Cloud {
    if now_secs() < CLOUD_PAUSED_UNTIL.load(AtomicOrdering::SeqCst) {
        return Cloud::Unavailable;
    }
    let fen = Fen::from_position(pos, EnPassantMode::Legal).to_string();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent("EnCroissant-Repertorio")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Cloud::Unavailable,
    };
    let response = client
        .get("https://lichess.org/api/cloud-eval")
        .query(&[
            ("fen", fen.as_str()),
            ("multiPv", &multipv.max(1).to_string()),
        ])
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            warn!("Lichess cloud eval unavailable: {}", e);
            pause_cloud();
            return Cloud::Unavailable;
        }
    };
    if response.status().as_u16() == 404 {
        return Cloud::Missing;
    }
    if !response.status().is_success() {
        warn!("Lichess cloud eval: HTTP {}", response.status());
        pause_cloud();
        return Cloud::Unavailable;
    }
    let Ok(eval) = response.json::<CloudEval>().await else {
        return Cloud::Missing;
    };
    match from_cloud(pos, eval) {
        Some(found) => Cloud::Found(found),
        None => Cloud::Missing,
    }
}

/// Lines of a Lichess cloud answer, with SAN moves computed from the position.
fn from_cloud(pos: &Chess, eval: CloudEval) -> Option<CachedEval> {
    let mut lines = Vec::new();
    for (i, pv) in eval.pvs.iter().enumerate() {
        let mut p = pos.clone();
        let mut uci_moves = Vec::new();
        let mut san_moves = Vec::new();
        for token in pv.moves.split_whitespace() {
            let Ok(uci) = token.parse::<UciMove>() else {
                break;
            };
            let Ok(m) = uci.to_move(&p) else { break };
            san_moves.push(SanPlus::from_move_and_play_unchecked(&mut p, m).to_string());
            uci_moves.push(uci.to_string());
        }
        if uci_moves.is_empty() {
            continue;
        }
        lines.push(CachedLine {
            uci_moves,
            san_moves,
            cp: pv.cp,
            mate: pv.mate,
            depth: eval.depth,
            multipv: (i + 1) as u16,
        });
    }
    if lines.is_empty() {
        return None;
    }
    Some(CachedEval {
        depth: eval.depth,
        lines,
        source: "lichess".to_string(),
        lichess_checked: true,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn eval_cache_stats(app: tauri::AppHandle) -> Result<EvalCacheStats, Error> {
    let positions = with_db(&app, |db| {
        db.query_row("SELECT COUNT(*) FROM evals", [], |row| row.get::<_, i64>(0))
    })?;
    let bytes = std::fs::metadata(db_path(&app)?)
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(EvalCacheStats {
        positions: positions as u32,
        bytes: bytes.min(u32::MAX as u64) as u32,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn eval_cache_clear(app: tauri::AppHandle) -> Result<(), Error> {
    with_db(&app, |db| db.execute_batch("DELETE FROM evals; VACUUM;"))
}

/// Stored evaluation of a position (any FEN; only opening positions are kept).
#[tauri::command]
#[specta::specta]
pub async fn eval_cache_get(
    app: tauri::AppHandle,
    fen: String,
) -> Result<Option<CachedEval>, Error> {
    match key_of_fen(&fen) {
        Some(key) => get(&app, &key),
        None => Ok(None),
    }
}

/// Stores the evaluation of an opening position (kept only if deeper than the stored one).
#[tauri::command]
#[specta::specta]
pub async fn eval_cache_put(
    app: tauri::AppHandle,
    fen: String,
    eval: CachedEval,
) -> Result<(), Error> {
    let Ok(fen) = fen.parse::<Fen>() else {
        return Ok(());
    };
    let setup = fen.as_setup().clone();
    let mode = CastlingMode::detect(&setup);
    let Ok(pos) = setup.position::<Chess>(mode) else {
        return Ok(());
    };
    if !is_opening(&pos) {
        return Ok(());
    }
    put(&app, &position_key(&pos), &eval)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(fen: &str) -> Chess {
        let fen: Fen = fen.parse().unwrap();
        fen.into_position(CastlingMode::Standard).unwrap()
    }

    #[test]
    fn key_ignores_move_counters_and_unplayable_en_passant() {
        let a = pos("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2");
        let b = pos("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 7 9");
        assert_eq!(position_key(&a), position_key(&b));
        // After 1.e4 no black pawn can take en passant: same key as without "e3".
        let c = pos("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
        let d = pos("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
        assert_eq!(position_key(&c), position_key(&d));
        assert_eq!(
            position_key(&d),
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -"
        );
    }

    #[test]
    fn opening_is_up_to_move_twenty() {
        assert!(is_opening(&pos(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 20"
        )));
        assert!(!is_opening(&pos(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 21"
        )));
    }

    #[test]
    fn cloud_answer_becomes_lines_with_san() {
        let start = Chess::default();
        let json = r#"{"fen":"x","knodes":1000,"depth":45,"pvs":[
            {"moves":"e2e4 e7e5 g1f3","cp":25},
            {"moves":"d2d4 d7d5","cp":18},
            {"moves":"g1f3","mate":-3}]}"#;
        let eval: CloudEval = serde_json::from_str(json).unwrap();
        let found = from_cloud(&start, eval).unwrap();
        assert_eq!(found.depth, 45);
        assert_eq!(found.source, "lichess");
        assert_eq!(found.lines[0].san_moves, vec!["e4", "e5", "Nf3"]);
        assert_eq!(found.lines[0].cp, Some(25));
        assert_eq!(found.lines[1].multipv, 2);
        assert_eq!(found.lines[2].mate, Some(-3));
    }
}
