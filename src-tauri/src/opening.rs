use log::info;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::San, Chess, EnPassantMode, Position, Setup};

use std::collections::HashMap;

use lazy_static::lazy_static;
use specta::Type;
use strsim::{jaro_winkler, sorensen_dice};

use crate::error::Error;

#[derive(Debug, Clone)]
struct Opening {
    _eco: String,
    name: String,
    setup: Setup,
    pgn: Option<String>,
}

#[derive(Debug, Clone, Type, Serialize)]
pub struct OutOpening {
    name: String,
    fen: String,
}

#[derive(Deserialize)]
struct OpeningRecord {
    eco: String,
    name: String,
    pgn: String,
}

const TSV_DATA: [&[u8]; 5] = [
    include_bytes!("../data/a.tsv"),
    include_bytes!("../data/b.tsv"),
    include_bytes!("../data/c.tsv"),
    include_bytes!("../data/d.tsv"),
    include_bytes!("../data/e.tsv"),
];

const FISCHER_RANDOM_DATA: &[u8] = include_bytes!("../data/frc.tsv");

#[derive(Deserialize)]
struct FischerRandomRecord {
    name: String,
    fen: String,
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_fen(fen: &str) -> Result<String, Error> {
    let fen: Fen = fen.parse()?;
    get_opening_from_setup(fen.into_setup())
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_name(name: &str) -> Result<String, Error> {
    OPENINGS
        .iter()
        .find(|o| o.name == name)
        .map(|o| o.pgn.clone().expect("opening without pgn"))
        .ok_or_else(|| Error::NoOpeningFound)
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_fens(fens: Vec<String>) -> Result<String, Error> {
    for fen in fens.into_iter().rev() {
        if let Ok(opening) = get_opening_from_fen(&fen) {
            return Ok(opening);
        }
    }
    Err(Error::NoOpeningFound)
}

pub fn get_opening_from_setup(setup: Setup) -> Result<String, Error> {
    OPENINGS
        .iter()
        .find(|o| o.setup == setup)
        .map(|o| o.name.clone())
        .ok_or_else(|| Error::NoOpeningFound)
}

/// Position without move counters, so that transpositions find their opening too.
fn position_key(setup: &Setup) -> Option<String> {
    let mut setup = setup.clone();
    setup.halfmoves = 0;
    setup.fullmoves = std::num::NonZeroU32::MIN;
    Fen::try_from_setup(setup).ok().map(|f| f.to_string())
}

/// Opening name of each game (its SAN moves from the starting position): the name of
/// the last position of the game, among its first 40 moves, found in the table.
#[tauri::command]
#[specta::specta]
pub async fn opening_names(games: Vec<Vec<String>>) -> Result<Vec<Option<String>>, Error> {
    Ok(games.iter().map(|moves| opening_of_moves(moves)).collect())
}

fn opening_of_moves(moves: &[String]) -> Option<String> {
    let mut pos = Chess::default();
    let mut name = None;
    for token in moves.iter().take(80) {
        let Ok(san) = token.parse::<San>() else { break };
        let Ok(m) = san.to_move(&pos) else { break };
        pos.play_unchecked(m);
        if let Some(key) = position_key(&pos.to_setup(EnPassantMode::Legal)) {
            if let Some(found) = OPENING_BY_POSITION.get(&key) {
                name = Some(found.clone());
            }
        }
    }
    name
}

#[tauri::command]
#[specta::specta]
pub async fn search_opening_name(query: String) -> Result<Vec<OutOpening>, Error> {
    let lower_query = query.to_lowercase();
    let scores = OPENINGS
        .iter()
        .map(|opening| {
            let lower_name = opening.name.to_lowercase();
            let sorenson_score = sorensen_dice(&lower_query, &lower_name);
            let jaro_score = jaro_winkler(&lower_query, &lower_name);
            let score = sorenson_score.max(jaro_score);
            (opening.clone(), score)
        })
        .collect::<Vec<_>>();
    let mut best_matches = scores
        .into_iter()
        .filter(|(_, score)| *score > 0.8)
        .collect::<Vec<_>>();

    best_matches.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    let best_matches_names = best_matches
        .iter()
        .map(|(o, _)| o.clone())
        .take(15)
        .map(|o| OutOpening {
            name: o.name,
            fen: Fen::try_from_setup(o.setup.clone()).unwrap().to_string(),
        })
        .collect();
    Ok(best_matches_names)
}

lazy_static! {
    static ref OPENINGS: Vec<Opening> = {
        info!("Initializing openings table...");

        let mut positions = vec![
            Opening {
                _eco: "Extra".to_string(),
                name: "Starting Position".to_string(),
                setup: Setup::default(),
                pgn: None,
            },
            Opening {
                _eco: "Extra".to_string(),
                name: "Empty Board".to_string(),
                setup: Setup::empty(),
                pgn: None,
            },
        ];

        for tsv in TSV_DATA {
            let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').from_reader(tsv);
            for result in rdr.deserialize() {
                let record: OpeningRecord = result.expect("Failed to deserialize opening");
                let mut pos = Chess::default();
                for token in record.pgn.split_whitespace() {
                    if let Ok(san) = token.parse::<San>() {
                        pos.play_unchecked(san.to_move(&pos).expect("legal move"));
                    }
                }
                positions.push(Opening {
                    _eco: record.eco,
                    name: record.name,
                    setup: pos.to_setup(EnPassantMode::Legal),
                    pgn: Some(record.pgn),
                });
            }
        }
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(b'\t')
            .from_reader(FISCHER_RANDOM_DATA);
        for result in rdr.deserialize() {
            let record: FischerRandomRecord = result.expect("Failed to deserialize opening");
            let fen: Fen = record.fen.parse().expect("Failed to parse fen");
            positions.push(Opening {
                _eco: "FRC".to_string(),
                name: record.name,
                setup: fen.into_setup(),
                pgn: None,
            });
        }
        positions
    };
    static ref OPENING_BY_POSITION: HashMap<String, String> = {
        let mut map = HashMap::new();
        for opening in OPENINGS.iter() {
            if opening.pgn.is_none() {
                continue;
            }
            if let Some(key) = position_key(&opening.setup) {
                // The first name listed for a position wins, as in the lookups above.
                map.entry(key).or_insert_with(|| opening.name.clone());
            }
        }
        map
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_opening() {
        let opening =
            get_opening_from_fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR b kq - 1 2")
                .unwrap();
        assert_eq!(opening, "Bongcloud Attack");
    }

    #[test]
    fn test_opening_names() {
        let moves = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
        let names = tauri::async_runtime::block_on(opening_names(vec![
            moves("e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Bb4 Bd3 O-O O-O h6 a3 Bxc3"),
            moves("e4 c5 c3"),
            moves("Nf3 d5 g3"),
            // Transposition: Caro-Kann Panov by another order.
            moves("c4 c6 e4 d5 exd5 cxd5 d4"),
            vec![],
        ]))
        .unwrap();
        assert!(names[0].as_deref().unwrap().starts_with("Caro-Kann Defense: Panov"));
        assert_eq!(names[1].as_deref(), Some("Sicilian Defense: Alapin Variation"));
        assert!(names[2].is_some());
        assert!(names[3].as_deref().unwrap().starts_with("Caro-Kann Defense: Panov"));
        assert_eq!(names[4], None);
    }
}
