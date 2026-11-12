use std::{
    fmt::Display,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use dashmap::DashMap;
use derivative::Derivative;
use governor::{Quota, RateLimiter};
use log::{info, warn};
use nonzero_ext::*;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, ByColor, CastlingMode, Chess, Color, EnPassantMode,
    Position, Role,
};
use specta::Type;
use tauri::Manager;
use tauri_specta::Event;
use tokio::sync::Mutex;
use vampirc_uci::{
    parse_one,
    uci::{Score, ScoreValue},
    UciInfoAttribute, UciMessage, UciOptionConfig,
};

use crate::{
    db::{position_in_db_blocking, GameQuery, PositionQueryJs},
    evalcache,
    engine::{
        parse_fen_and_apply_moves, BaseEngine, EngineLog, EngineOption, EngineReader, GoMode,
    },
    error::Error,
    progress::update_progress,
    AppState,
};

pub struct EngineProcess {
    base: BaseEngine,
    last_depth: u32,
    best_moves: Vec<BestMoves>,
    last_best_moves: Vec<BestMoves>,
    last_progress: f32,
    options: EngineOptions,
    go_mode: GoMode,
    running: bool,
    real_multipv: u16,
    start: Instant,
}

impl EngineProcess {
    async fn new(path: PathBuf) -> Result<(Self, EngineReader), Error> {
        let mut base = BaseEngine::spawn(path).await?;
        base.init_uci().await?;
        let reader = base.take_reader().ok_or(Error::EngineDisconnected)?;

        Ok((
            Self {
                base,
                last_depth: 0,
                best_moves: Vec::new(),
                last_best_moves: Vec::new(),
                last_progress: 0.0,
                options: EngineOptions::default(),
                real_multipv: 0,
                go_mode: GoMode::Infinite,
                running: false,
                start: Instant::now(),
            },
            reader,
        ))
    }

    async fn set_option<T>(&mut self, name: &str, value: T) -> Result<(), Error>
    where
        T: Display,
    {
        self.base.set_option(name, value).await
    }

    async fn set_options(&mut self, options: EngineOptions) -> Result<(), Error> {
        let fen_changed = options.fen != self.options.fen;
        let fen: Fen = options.fen.parse()?;
        let setup = fen.as_setup();
        let castling_mode = CastlingMode::detect(setup);
        let pos = parse_fen_and_apply_moves(&options.fen, &options.moves)?;

        if fen_changed {
            if castling_mode.is_chess960() {
                self.set_option("UCI_Chess960", "true").await?;
            } else {
                self.set_option("UCI_Chess960", "false").await?;
            }
        }

        let multipv = options
            .extra_options
            .iter()
            .find(|x| x.name == "MultiPV")
            .map(|x| x.value.parse().unwrap_or(1))
            .unwrap_or(1);

        self.real_multipv = multipv.min(pos.legal_moves().len() as u16);

        for option in &options.extra_options {
            if !self.options.extra_options.contains(option) && option.name != "UCI_Chess960" {
                self.set_option(&option.name, &option.value).await?;
            }
        }

        if fen_changed || options.moves != self.options.moves {
            self.set_position(&options.fen, &options.moves).await?;
        }
        self.last_depth = 0;
        self.options = options.clone();
        self.best_moves.clear();
        self.last_best_moves.clear();
        Ok(())
    }

    async fn set_position(&mut self, fen: &str, moves: &[String]) -> Result<(), Error> {
        self.base.set_position(fen, moves).await?;
        self.options.fen = fen.to_string();
        self.options.moves = moves.to_owned();
        Ok(())
    }

    async fn go(&mut self, mode: &GoMode) -> Result<(), Error> {
        self.go_mode = mode.clone();
        self.base.go(mode).await?;
        self.running = true;
        self.start = Instant::now();
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), Error> {
        self.base.stop().await?;
        self.running = false;
        Ok(())
    }

    async fn kill(&mut self) -> Result<(), Error> {
        self.base.quit().await?;
        self.running = false;
        Ok(())
    }

    pub fn kill_sync(&mut self) {
        self.base.kill_sync();
    }
}

#[derive(Clone, Serialize, Debug, Derivative, Type)]
#[derivative(Default)]
pub struct BestMoves {
    nodes: u32,
    depth: u32,
    score: Score,
    #[serde(rename = "uciMoves")]
    uci_moves: Vec<String>,
    #[serde(rename = "sanMoves")]
    san_moves: Vec<String>,
    #[derivative(Default(value = "1"))]
    multipv: u16,
    nps: u32,
}

#[derive(Serialize, Debug, Clone, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BestMovesPayload {
    pub best_lines: Vec<BestMoves>,
    pub engine: String,
    pub tab: String,
    pub fen: String,
    pub moves: Vec<String>,
    pub progress: f64,
}

fn invert_score(score: Score) -> Score {
    let new_value = match score.value {
        ScoreValue::Cp(x) => ScoreValue::Cp(-x),
        ScoreValue::Mate(x) => ScoreValue::Mate(-x),
    };
    let new_wdl = score.wdl.map(|(w, d, l)| (l, d, w));
    Score {
        value: new_value,
        wdl: new_wdl,
        ..score
    }
}

fn parse_uci_attrs(
    attrs: Vec<UciInfoAttribute>,
    fen: &Fen,
    moves: &[String],
) -> Result<BestMoves, Error> {
    let mut best_moves = BestMoves::default();

    let mut pos = parse_fen_and_apply_moves(&fen.to_string(), moves)?;
    let turn = pos.turn();

    for a in attrs {
        match a {
            UciInfoAttribute::Pv(m) => {
                for mv in m {
                    let uci: UciMove = mv.to_string().parse()?;
                    let m = uci.to_move(&pos)?;
                    let san = SanPlus::from_move_and_play_unchecked(&mut pos, m);
                    best_moves.san_moves.push(san.to_string());
                    best_moves.uci_moves.push(uci.to_string());
                }
            }
            UciInfoAttribute::Nps(nps) => {
                best_moves.nps = nps as u32;
            }
            UciInfoAttribute::Nodes(nodes) => {
                best_moves.nodes = nodes as u32;
            }
            UciInfoAttribute::Depth(depth) => {
                best_moves.depth = depth;
            }
            UciInfoAttribute::MultiPv(multipv) => {
                best_moves.multipv = multipv;
            }
            UciInfoAttribute::Score(score) => {
                best_moves.score = score;
            }
            _ => (),
        }
    }

    if best_moves.san_moves.is_empty() {
        return Err(Error::NoMovesFound);
    }

    if turn == Color::Black {
        best_moves.score = invert_score(best_moves.score);
    }

    Ok(best_moves)
}

#[derive(Deserialize, Debug, Clone, Type, Derivative, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
#[derivative(Default)]
pub struct EngineOptions {
    pub fen: String,
    pub moves: Vec<String>,
    pub extra_options: Vec<EngineOption>,
}

#[tauri::command]
#[specta::specta]
pub async fn kill_engines(tab: String, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    let keys: Vec<_> = state
        .engine_processes
        .iter()
        .map(|x| x.key().clone())
        .collect();
    for key in keys.clone() {
        if key.0.starts_with(&tab) {
            {
                let process = state.engine_processes.get_mut(&key).unwrap();
                let mut process = process.lock().await;
                process.kill().await?;
            }
            state.engine_processes.remove(&key);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn kill_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let mut process = process.lock().await;
        process.kill().await?;
    }
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn stop_engine(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let mut process = process.lock().await;
        process.stop().await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_logs(
    engine: String,
    tab: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EngineLog>, Error> {
    let key = (tab, engine);
    if let Some(process) = state.engine_processes.get(&key) {
        let process = process.lock().await;
        Ok(process.base.get_logs())
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_best_moves(
    id: String,
    engine: String,
    tab: String,
    go_mode: GoMode,
    options: EngineOptions,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<(f32, Vec<BestMoves>)>, Error> {
    let path = PathBuf::from(&engine);

    let key = (tab.clone(), id.clone());

    let setup_validation = parse_fen_and_apply_moves(&options.fen, &options.moves);
    if let Err(e) = setup_validation {
        warn!("Invalid position for engine: {:?}", e);
        if let Some(process) = state.engine_processes.get(&key) {
            process.lock().await.stop().await?;
        }
        return Ok(None);
    }

    if state.engine_processes.contains_key(&key) {
        {
            let process = state.engine_processes.get_mut(&key).unwrap();
            let mut process = process.lock().await;
            if options == process.options && go_mode == process.go_mode && process.running {
                return Ok(Some((
                    process.last_progress,
                    process.last_best_moves.clone(),
                )));
            }
            process.stop().await?;
        }
        // give time for engine to stop and process previous lines
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        {
            let process = state.engine_processes.get_mut(&key).unwrap();
            let mut process = process.lock().await;
            process.set_options(options.clone()).await?;
            process.go(&go_mode).await?;
        }
        return Ok(None);
    }

    let (mut process, mut reader) = EngineProcess::new(path).await?;
    process.set_options(options.clone()).await?;
    process.go(&go_mode).await?;

    let process = Arc::new(Mutex::new(process));

    state.engine_processes.insert(key.clone(), process.clone());

    let lim = RateLimiter::direct(Quota::per_second(nonzero!(5u32)));

    while let Some(line) = reader.next_line().await? {
        let mut proc = process.lock().await;
        match parse_one(&line) {
            UciMessage::Info(attrs) => {
                match parse_uci_attrs(attrs, &proc.options.fen.parse()?, &proc.options.moves) {
                    Ok(best_moves) => {
                        if best_moves.score.lower_bound == Some(true)
                            || best_moves.score.upper_bound == Some(true)
                        {
                            continue;
                        }
                        let multipv = best_moves.multipv;
                        let cur_depth = best_moves.depth;
                        let cur_nodes = best_moves.nodes;
                        if multipv as usize == proc.best_moves.len() + 1 {
                            proc.best_moves.push(best_moves);
                            if multipv == proc.real_multipv {
                                if proc.best_moves.iter().all(|x| x.depth == cur_depth)
                                    && cur_depth >= proc.last_depth
                                    && lim.check().is_ok()
                                {
                                    let progress = match proc.go_mode {
                                        GoMode::Depth(depth) => {
                                            (cur_depth as f64 / depth as f64) * 100.0
                                        }
                                        GoMode::Time(time) => {
                                            (proc.start.elapsed().as_millis() as f64 / time as f64)
                                                * 100.0
                                        }
                                        GoMode::Nodes(nodes) => {
                                            (cur_nodes as f64 / nodes as f64) * 100.0
                                        }
                                        GoMode::PlayersTime(_) => 99.99,
                                        GoMode::Infinite => 99.99,
                                    };
                                    BestMovesPayload {
                                        best_lines: proc.best_moves.clone(),
                                        engine: id.clone(),
                                        tab: tab.clone(),
                                        fen: proc.options.fen.clone(),
                                        moves: proc.options.moves.clone(),
                                        progress,
                                    }
                                    .emit(&app)?;
                                    proc.last_depth = cur_depth;
                                    proc.last_best_moves = proc.best_moves.clone();
                                    proc.last_progress = progress as f32;
                                }
                                proc.best_moves.clear();
                            }
                        }
                    }
                    Err(e) => match e {
                        Error::NoMovesFound => {}
                        _ => {
                            warn!("Failed to parse info line: {}, error: {:?}", line, e);
                        }
                    },
                }
            }
            UciMessage::BestMove { .. } => {
                BestMovesPayload {
                    best_lines: proc.last_best_moves.clone(),
                    engine: id.clone(),
                    tab: tab.clone(),
                    fen: proc.options.fen.clone(),
                    moves: proc.options.moves.clone(),
                    progress: 100.0,
                }
                .emit(&app)?;
                proc.last_progress = 100.0;
            }
            _ => {}
        }
        proc.base.log_engine(&line);
    }
    info!("Engine process finished: tab: {}, engine: {}", tab, engine);
    state.engine_processes.remove(&key);
    Ok(None)
}

#[derive(Serialize, Debug, Default, Type)]
pub struct MoveAnalysis {
    best: Vec<BestMoves>,
    novelty: bool,
    is_sacrifice: bool,
}

#[derive(Deserialize, Debug, Default, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    pub fen: String,
    pub moves: Vec<String>,
    pub annotate_novelties: bool,
    pub reference_db: Option<PathBuf>,
    pub reversed: bool,
    /// Use (and fill) the local database of opening evaluations.
    #[serde(default)]
    pub eval_cache: bool,
    /// Also ask the Lichess cloud for opening positions not deep enough locally.
    #[serde(default)]
    pub cloud_eval: bool,
}

impl BestMoves {
    /// A stored line (score from White's point of view) as the engine would give it.
    fn from_cached(line: &evalcache::CachedLine) -> Self {
        let value = match (line.cp, line.mate) {
            (_, Some(m)) => ScoreValue::Mate(m),
            (Some(cp), None) => ScoreValue::Cp(cp),
            (None, None) => ScoreValue::Cp(0),
        };
        BestMoves {
            nodes: 0,
            depth: line.depth,
            score: Score {
                value,
                ..Default::default()
            },
            uci_moves: line.uci_moves.clone(),
            san_moves: line.san_moves.clone(),
            multipv: line.multipv,
            nps: 0,
        }
    }

    fn to_cached(&self) -> evalcache::CachedLine {
        let (cp, mate) = match self.score.value {
            ScoreValue::Cp(cp) => (Some(cp), None),
            ScoreValue::Mate(m) => (None, Some(m)),
        };
        evalcache::CachedLine {
            uci_moves: self.uci_moves.clone(),
            san_moves: self.san_moves.clone(),
            cp,
            mate,
            depth: self.depth,
            multipv: self.multipv,
        }
    }
}

/// Evaluation of an opening position already known (local database, or the Lichess
/// cloud when allowed), deep enough for `go_mode` and with `lines` lines.
async fn known_evaluation(
    app: &tauri::AppHandle,
    pos: &Chess,
    go_mode: &GoMode,
    lines: usize,
    cloud: &mut bool,
) -> Option<Vec<BestMoves>> {
    let key = evalcache::position_key(pos);
    let mut known = evalcache::get(app, &key).ok().flatten();
    if *cloud && !known.as_ref().map(|k| k.lichess_checked).unwrap_or(false) {
        match evalcache::lichess_cloud(pos, lines).await {
            evalcache::Cloud::Found(eval) => {
                // The deeper evaluation wins (usually the cloud's).
                let _ = evalcache::put(app, &key, &eval);
                let _ = evalcache::mark_lichess_checked(app, &key);
                known = evalcache::get(app, &key).ok().flatten();
            }
            evalcache::Cloud::Missing => {
                let _ = evalcache::mark_lichess_checked(app, &key);
            }
            evalcache::Cloud::Unavailable => *cloud = false,
        }
    }
    let known = known?;
    let required = match go_mode {
        GoMode::Depth(d) => *d,
        _ => evalcache::TIME_MODE_MIN_DEPTH,
    };
    if known.depth < required || known.lines.len() < lines {
        return None;
    }
    Some(known.lines.iter().take(lines).map(BestMoves::from_cached).collect())
}

/// Longest time the engine may stay silent while analysing one position of a report
/// before it is considered stuck (it normally prints "info" lines all the time).
fn report_engine_timeout(go_mode: &GoMode) -> Duration {
    match go_mode {
        GoMode::Time(ms) => Duration::from_millis(*ms as u64) + Duration::from_secs(15),
        _ => Duration::from_secs(120),
    }
}

/// Longest time allowed to check one position against the reference database.
const NOVELTY_QUERY_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest time for the whole novelty search of a report.
const NOVELTY_PHASE_TIMEOUT: Duration = Duration::from_secs(90);

/// How often a running report checks for cancellation and engine timeouts.
const REPORT_POLL_INTERVAL: Duration = Duration::from_millis(250);

enum PositionOutcome {
    Done(MoveAnalysis),
    Cancelled,
    /// The engine stopped answering (stuck, crashed or closed its output).
    Unresponsive,
}

/// Analyses one position of a report. Never waits forever: it returns when the engine
/// answers, when the report is cancelled or when the engine stays silent too long.
async fn analyse_report_position(
    proc: &mut EngineProcess,
    reader: &mut EngineReader,
    fen: &str,
    moves: &[String],
    go_mode: &GoMode,
    uci_options: &[EngineOption],
    cancel_flag: &AtomicBool,
) -> Result<PositionOutcome, Error> {
    let mut extra_options = uci_options.to_vec();
    if !extra_options.iter().any(|x| x.name == "MultiPV") {
        extra_options.push(EngineOption {
            name: "MultiPV".to_string(),
            value: "2".to_string(),
        });
    } else {
        extra_options.iter_mut().for_each(|x| {
            if x.name == "MultiPV" {
                x.value = "2".to_string();
            }
        });
    }

    proc.set_options(EngineOptions {
        fen: fen.to_string(),
        moves: moves.to_vec(),
        extra_options,
    })
    .await?;
    proc.go(go_mode).await?;

    let max_silence = report_engine_timeout(go_mode);
    let mut last_output = Instant::now();
    let mut current_analysis = MoveAnalysis::default();
    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            return Ok(PositionOutcome::Cancelled);
        }
        if last_output.elapsed() > max_silence {
            return Ok(PositionOutcome::Unresponsive);
        }
        // `next_line` is cancel safe, so polling it with a timeout loses nothing.
        let line = match tokio::time::timeout(REPORT_POLL_INTERVAL, reader.next_line()).await {
            Err(_) => continue,
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) | Ok(Err(_)) => return Ok(PositionOutcome::Unresponsive),
        };
        last_output = Instant::now();
        match parse_one(&line) {
            UciMessage::Info(attrs) => {
                if let Ok(best_moves) = parse_uci_attrs(attrs, &proc.options.fen.parse()?, moves)
                {
                    let multipv = best_moves.multipv;
                    let cur_depth = best_moves.depth;
                    if multipv as usize == proc.best_moves.len() + 1 {
                        proc.best_moves.push(best_moves);
                        if multipv == proc.real_multipv {
                            if proc.best_moves.iter().all(|x| x.depth == cur_depth)
                                && cur_depth >= proc.last_depth
                            {
                                current_analysis.best = proc.best_moves.clone();
                                proc.last_depth = cur_depth;
                            }
                            proc.best_moves.clear();
                        }
                    }
                }
            }
            UciMessage::BestMove { .. } => return Ok(PositionOutcome::Done(current_analysis)),
            _ => {}
        }
    }
}

/// Removes the cancel flag of a report when it ends, but only if it is still this
/// report's flag (a newer report with the same id may have replaced it).
struct CancelFlagGuard<'a> {
    flags: &'a DashMap<String, Arc<AtomicBool>>,
    id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for CancelFlagGuard<'_> {
    fn drop(&mut self) {
        self.flags
            .remove_if(&self.id, |_, current| Arc::ptr_eq(current, &self.flag));
    }
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_analysis(id: String, state: tauri::State<'_, AppState>) -> Result<(), Error> {
    if let Some(flag) = state.analysis_cancel_flags.get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn analyze_game(
    id: String,
    engine: String,
    go_mode: GoMode,
    options: AnalysisOptions,
    uci_options: Vec<EngineOption>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<MoveAnalysis>, Error> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    // A report still running for the same tab is stopped: only one at a time.
    if let Some(previous) = state
        .analysis_cancel_flags
        .insert(id.clone(), cancel_flag.clone())
    {
        previous.store(true, Ordering::SeqCst);
    }
    let _guard = CancelFlagGuard {
        flags: &state.analysis_cancel_flags,
        id: id.clone(),
        flag: cancel_flag.clone(),
    };
    if options.annotate_novelties && options.reference_db.is_none() {
        return Err(Error::MissingReferenceDatabase);
    }

    let path = PathBuf::from(&engine);
    let mut analysis: Vec<MoveAnalysis> = Vec::new();

    let (mut proc, mut reader) = EngineProcess::new(path.clone()).await?;

    let fen = Fen::from_ascii(options.fen.as_bytes())?;
    let setup = fen.as_setup().clone();
    let castling_mode = CastlingMode::detect(&setup);

    let mut chess: Chess = setup.position(castling_mode)?;
    let mut fens: Vec<(Fen, Vec<String>, bool)> = vec![(fen, vec![], false)];

    options
        .moves
        .iter()
        .enumerate()
        .try_for_each(|(i, m)| -> Result<(), Error> {
            let uci = UciMove::from_ascii(m.as_bytes())?;
            let m = uci.to_move(&chess)?;
            let previous_pos = chess.clone();
            chess.play_unchecked(m);
            let current_pos = chess.clone();
            if !chess.is_game_over() {
                let prev_eval = naive_eval(&previous_pos);
                let cur_eval = -naive_eval(&current_pos);
                fens.push((
                    Fen::from_position(&current_pos, EnPassantMode::Legal),
                    options.moves.clone().into_iter().take(i + 1).collect(),
                    prev_eval > cur_eval + 100,
                ));
            }
            Ok(())
        })?;

    if options.reversed {
        fens.reverse();
    }

    let mut novelty_found = false;
    // Lines the engine gives for each position (MultiPV of the report, 2 by default).
    let wanted_lines = uci_options
        .iter()
        .find(|o| o.name == "MultiPV")
        .and_then(|o| o.value.parse::<usize>().ok())
        .unwrap_or(2)
        .max(1);
    let mut cloud = options.cloud_eval;

    for (i, (_, moves, _)) in fens.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            proc.kill_sync();
            return Err(Error::AnalysisCancelled);
        }

        update_progress(
            &state.progress_state,
            &app,
            id.clone(),
            (i as f32 / fens.len() as f32) * 100.0,
            false,
        )?;

        // Opening positions already evaluated deeply enough are not analysed again.
        let opening_pos = if options.eval_cache {
            parse_fen_and_apply_moves(&options.fen, moves)
                .ok()
                .filter(evalcache::is_opening)
        } else {
            None
        };
        if let Some(pos) = &opening_pos {
            let lines = wanted_lines.min(pos.legal_moves().len());
            if lines > 0 {
                if let Some(best) = known_evaluation(&app, pos, &go_mode, lines, &mut cloud).await
                {
                    analysis.push(MoveAnalysis {
                        best,
                        ..Default::default()
                    });
                    continue;
                }
            }
        }

        // If the engine stops answering, restart it once and retry the position.
        let mut attempt = 0;
        let current_analysis = loop {
            let outcome = analyse_report_position(
                &mut proc,
                &mut reader,
                &options.fen,
                moves,
                &go_mode,
                &uci_options,
                &cancel_flag,
            )
            .await;
            match outcome {
                Ok(PositionOutcome::Done(result)) => break result,
                Ok(PositionOutcome::Cancelled) => {
                    proc.kill_sync();
                    return Err(Error::AnalysisCancelled);
                }
                Ok(PositionOutcome::Unresponsive) | Err(Error::EngineDisconnected)
                    if attempt == 0 =>
                {
                    warn!(
                        "Report {}: engine not responding at position {}, restarting it",
                        id, i
                    );
                    proc.kill_sync();
                    let (new_proc, new_reader) = EngineProcess::new(path.clone()).await?;
                    proc = new_proc;
                    reader = new_reader;
                    attempt += 1;
                }
                Ok(PositionOutcome::Unresponsive) => {
                    proc.kill_sync();
                    return Err(Error::EngineNotResponding);
                }
                Err(e) => {
                    proc.kill_sync();
                    return Err(e);
                }
            }
        };
        if let Some(pos) = &opening_pos {
            if !current_analysis.best.is_empty() {
                let depth = current_analysis.best.iter().map(|b| b.depth).min().unwrap_or(0);
                let eval = evalcache::CachedEval {
                    depth,
                    lines: current_analysis.best.iter().map(BestMoves::to_cached).collect(),
                    source: engine_name(&engine),
                    lichess_checked: false,
                };
                if let Err(e) = evalcache::put(&app, &evalcache::position_key(pos), &eval) {
                    warn!("Evaluation database: {}", e);
                }
            }
        }
        analysis.push(current_analysis);
    }
    proc.kill_sync();

    if options.reversed {
        analysis.reverse();
        fens.reverse();
    }

    // Second phase: look for the first move that is not in the reference database.
    // Reported as 100% "not finished" so the UI can say what is going on.
    update_progress(&state.progress_state, &app, id.clone(), 100.0, false)?;
    let novelty_phase_start = Instant::now();
    let reference_db = options.reference_db.clone().filter(|_| options.annotate_novelties);
    let mut novelty_search_done = reference_db.is_none();
    for (i, analysis) in analysis.iter_mut().enumerate() {
        analysis.is_sacrifice = fens[i].2;
        if novelty_search_done {
            continue;
        }
        if novelty_phase_start.elapsed() > NOVELTY_PHASE_TIMEOUT {
            warn!("Report {}: novelty search too slow, giving up", id);
            novelty_search_done = true;
            continue;
        }
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(Error::AnalysisCancelled);
        }
        let reference = reference_db.clone().unwrap_or_default();
        let query = GameQuery::new()
            .position(PositionQueryJs {
                fen: fens[i].0.to_string(),
                type_: "exact".to_string(),
            })
            .clone();
        // The DuckDB query blocks: run it on a blocking thread with a time limit, so
        // a slow or locked database can't keep the report from finishing.
        let app_handle = app.clone();
        let lookup = tokio::task::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            position_in_db_blocking(&state, &reference, &query)
        });
        match tokio::time::timeout(NOVELTY_QUERY_TIMEOUT, lookup).await {
            Ok(Ok(Ok(in_db))) => {
                analysis.novelty = !in_db;
                if analysis.novelty {
                    novelty_search_done = true;
                }
            }
            Ok(Ok(Err(e))) => {
                warn!("Report {}: novelty search failed, skipping it: {}", id, e);
                novelty_search_done = true;
            }
            Ok(Err(e)) => {
                warn!("Report {}: novelty search crashed, skipping it: {}", id, e);
                novelty_search_done = true;
            }
            Err(_) => {
                warn!(
                    "Report {}: novelty search took more than {:?}, skipping it",
                    id, NOVELTY_QUERY_TIMEOUT
                );
                novelty_search_done = true;
            }
        }
    }
    update_progress(&state.progress_state, &app, id.clone(), 100.0, true)?;
    Ok(analysis)
}

fn count_material(position: &Chess) -> i32 {
    if position.is_checkmate() {
        return -10000;
    }
    let material: ByColor<i32> = position.board().material().map(|p| {
        p.pawn as i32 * piece_value(Role::Pawn)
            + p.knight as i32 * piece_value(Role::Knight)
            + p.bishop as i32 * piece_value(Role::Bishop)
            + p.rook as i32 * piece_value(Role::Rook)
            + p.queen as i32 * piece_value(Role::Queen)
    });
    if position.turn() == Color::White {
        material.white - material.black
    } else {
        material.black - material.white
    }
}

fn piece_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 90,
        Role::Knight => 300,
        Role::Bishop => 300,
        Role::Rook => 500,
        Role::Queen => 1000,
        _ => 0,
    }
}

fn qsearch(position: &Chess, mut alpha: i32, beta: i32) -> i32 {
    let stand_pat = count_material(position);

    if stand_pat >= beta {
        return beta;
    }
    if alpha < stand_pat {
        alpha = stand_pat;
    }
    let legal_moves = position.legal_moves();
    let mut captures: Vec<_> = legal_moves.iter().filter(|m| m.is_capture()).collect();

    captures.sort_by(|a, b| {
        let a_value = piece_value(a.capture().unwrap());
        let b_value = piece_value(b.capture().unwrap());
        b_value.cmp(&a_value)
    });

    for capture in captures {
        let mut new_position = position.clone();
        new_position.play_unchecked(*capture);
        let score = -qsearch(&new_position, -beta, -alpha);
        if score >= beta {
            return beta;
        }
        if score > alpha {
            alpha = score;
        }
    }

    alpha
}

fn naive_eval(pos: &Chess) -> i32 {
    pos.legal_moves()
        .iter()
        .map(|mv| {
            let mut new_position = pos.clone();
            new_position.play_unchecked(*mv);
            -qsearch(&new_position, i32::MIN, i32::MAX)
        })
        .max()
        .unwrap_or(i32::MIN)
}

#[cfg(test)]
mod tests {
    use shakmaty::FromSetup;

    use super::*;

    fn pos(fen: &str) -> Chess {
        let fen: Fen = fen.parse().unwrap();
        Chess::from_setup(fen.into_setup(), CastlingMode::Chess960).unwrap()
    }

    #[test]
    fn eval_start_pos() {
        assert_eq!(naive_eval(&Chess::default()), 0);
    }

    #[test]
    fn eval_scandi() {
        let position = pos("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
        assert_eq!(naive_eval(&position), 0);
    }

    #[test]
    fn eval_hanging_pawn() {
        let position = pos("r1bqkbnr/ppp1pppp/2n5/1B1p4/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3");
        assert_eq!(naive_eval(&position), 90);
    }

    #[test]
    fn eval_complex_center() {
        let position = pos("r1bqkbnr/ppp2ppp/2n5/1B1pp3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4");
        assert_eq!(naive_eval(&position), 90);
    }

    #[test]
    fn eval_in_check() {
        let position = pos("r1bqkbnr/ppp2ppp/2B5/3pp3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4");
        assert_eq!(naive_eval(&position), -90);
    }

    #[test]
    fn eval_rook_stack() {
        let position = pos("rnrq4/8/8/1R6/1R6/1R5K/1Q6/7k w - - 0 1");
        assert_eq!(naive_eval(&position), 10000);
    }

    #[test]
    fn eval_rook_stack2() {
        let position = pos("rnrq4/8/8/1R6/1Q6/1R5K/1R6/7k w - - 0 1");
        assert_eq!(naive_eval(&position), 10000);
    }

    #[test]
    fn eval_opera_game1() {
        let position = pos("4kb1r/p2rqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2K4R w k - 0 14");
        assert_eq!(naive_eval(&position), -120);
    }

    #[test]
    fn eval_opera_game2() {
        let position = pos("4kb1r/p2rqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2KR4 b k - 1 14");
        assert_eq!(naive_eval(&position), 20);
    }
}

#[derive(Type, Default, Serialize, Debug)]
pub struct EngineConfig {
    pub name: String,
    pub options: Vec<UciOptionConfig>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_engine_config(path: PathBuf) -> Result<EngineConfig, Error> {
    let mut base = BaseEngine::spawn(path).await?;

    base.send("uci").await?;

    let mut config = EngineConfig::default();

    let reader = base.reader_mut().ok_or(Error::EngineDisconnected)?;
    while let Some(line) = reader.next_line().await? {
        if let UciMessage::Id {
            name: Some(name),
            author: _,
        } = parse_one(&line)
        {
            config.name = name;
        }
        if let UciMessage::Option(opt) = parse_one(&line) {
            config.options.push(opt);
        }
        if let UciMessage::UciOk = parse_one(&line) {
            break;
        }
    }
    println!("{:?}", config);
    base.quit().await?;
    Ok(config)
}

/// Engine name from its path (e.g. "stockfish-17"), recorded with stored evaluations.
fn engine_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "engine".to_string())
}
