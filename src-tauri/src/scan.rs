//! Chess diagrams in images (screenshots, PDF pages, scanned books): finds the boards
//! and reads their pieces.
//!
//! Board detection follows the approach of chessvision (Harshit Pawar, GPL-3.0,
//! https://github.com/harshitpawar64/chessvision): candidate squares from Otsu and Canny
//! contours, checked for an 8x8 checker pattern. The pieces are read by its piece
//! classifier (`resources/vision/board-pieces.onnx`), one 64x64 square at a time.

use image::{imageops, GrayImage, ImageReader, Limits, Luma, Rgb, RgbImage};
use imageproc::{
    contours::find_contours,
    contrast::{otsu_level, threshold, ThresholdType},
    distance_transform::Norm,
    edges::canny,
    geometric_transformations::{warp_into, Interpolation, Projection},
    geometry::{approximate_polygon_dp, arc_length, contour_area, convex_hull},
    gradients::{horizontal_sobel, vertical_sobel},
    morphology::{close, dilate},
    point::Point,
};
use serde::Serialize;
use specta::Type;
use std::{path::Path, sync::Mutex};
use tauri::Manager;
use tract_onnx::prelude::*;

const MIN_BOARD: u32 = 64;
const WARPED: u32 = 512;
const SQUARE: u32 = 64;
/// Model classes, in the order of its output.
const CLASSES: [char; 13] = [
    'b', 'k', 'n', 'p', 'q', 'r', '.', 'B', 'K', 'N', 'P', 'Q', 'R',
];

#[derive(Serialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScannedBoard {
    /// Where the board is in the image (pixels).
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// 64 squares from a8 to h1: FEN letter, or '.' when empty.
    pub squares: String,
    /// How sure the model is of each square (0–1), same order.
    pub confidence: Vec<f32>,
    /// The diagram had Black at the bottom (squares are already turned).
    pub flipped: bool,
}

#[derive(Serialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub width: u32,
    pub height: u32,
    pub boards: Vec<ScannedBoard>,
}

type Model = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;
static MODEL: Mutex<Option<Model>> = Mutex::new(None);

/// Reads the chess diagrams of an image, given as a file or as base64 data (pasted).
#[tauri::command]
#[specta::specta]
pub async fn scan_board_image(
    app: tauri::AppHandle,
    path: Option<String>,
    data: Option<String>,
) -> Result<ScanResult, String> {
    let model = app
        .path()
        .resolve("vision/board-pieces.onnx", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || {
        let bytes = match (path, data) {
            (Some(path), _) => std::fs::read(&path).map_err(|e| format!("Could not open image: {e}"))?,
            (None, Some(data)) => decode_base64(&data)?,
            (None, None) => return Err("No image".to_string()),
        };
        scan_bytes(&bytes, &model)
    })
    .await
    .map_err(|e| format!("Image recognition task failed: {e}"))?
}

pub fn scan_bytes(bytes: &[u8], model_path: &Path) -> Result<ScanResult, String> {
    let mut reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Could not read image: {e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| format!("Could not decode image: {e}"))?
        .to_rgb8();

    let mut guard = MODEL.lock().map_err(|_| "Image recognizer is unavailable")?;
    if guard.is_none() {
        *guard = Some(load_model(model_path).map_err(|e| format!("Could not load the model: {e}"))?);
    }
    let model = guard.as_ref().ok_or("Image recognizer is unavailable")?;

    let mut boards = Vec::new();
    for found in detect(&image) {
        let (squares, confidence) = classify(model, &found.image).map_err(|e| e.to_string())?;
        boards.push(oriented(found, squares, confidence));
    }
    Ok(ScanResult { width: image.width(), height: image.height(), boards })
}

fn load_model(path: &Path) -> TractResult<Model> {
    tract_onnx::onnx()
        .model_for_path(path)?
        .with_input_fact(0, f32::fact([64, 3, SQUARE as usize, SQUARE as usize]).into())?
        .into_optimized()?
        .into_runnable()
}

// --- Detection ---

struct Found {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    score: f32,
    /// The board alone (cropped, or straightened when seen at an angle).
    image: RgbImage,
}

fn gray_of(image: &RgbImage) -> GrayImage {
    GrayImage::from_fn(image.width(), image.height(), |x, y| {
        let Rgb([r, g, b]) = *image.get_pixel(x, y);
        Luma([(0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32).round() as u8])
    })
}

fn detect(image: &RgbImage) -> Vec<Found> {
    let (width, height) = image.dimensions();
    if width.min(height) < MIN_BOARD {
        return vec![];
    }
    let gray = gray_of(image);
    let min_dim = width.min(height) as f32;
    let (min_size, max_size) = (min_dim * 0.10, min_dim * 1.05);

    let mean = gray.pixels().map(|p| p[0] as f64).sum::<f64>() / (width * height) as f64;
    let level = otsu_level(&gray);
    let binary = threshold(
        &gray,
        level,
        if mean < 128.0 { ThresholdType::Binary } else { ThresholdType::BinaryInverted },
    );
    let binary = close(&binary, Norm::LInf, 1);
    let edges = dilate(&canny(&gray, 40.0, 150.0), Norm::LInf, 2);

    let mut candidates = Vec::new();
    for contour in find_contours::<i32>(&binary).into_iter().chain(find_contours::<i32>(&edges)) {
        let points = contour.points;
        if points.len() < 4 {
            continue;
        }
        let (min_x, max_x) = points.iter().fold((i32::MAX, i32::MIN), |(a, b), p| (a.min(p.x), b.max(p.x)));
        let (min_y, max_y) = points.iter().fold((i32::MAX, i32::MIN), |(a, b), p| (a.min(p.y), b.max(p.y)));
        let (bw, bh) = ((max_x - min_x + 1) as f32, (max_y - min_y + 1) as f32);
        if !(min_size <= bw && bw <= max_size && min_size <= bh && bh <= max_size) {
            continue;
        }
        if !(0.75..=1.35).contains(&(bw / bh)) {
            continue;
        }
        let hull = convex_hull(points);
        let fill = contour_area(&hull).abs() as f32 / (bw * bh);
        if fill >= 0.95 {
            // An upright board: cut it out, trimming any frame or coordinates around it.
            let sub = imageops::crop_imm(&gray, min_x as u32, min_y as u32, bw as u32, bh as u32).to_image();
            let (x1, y1, x2, y2) = snap(&sub);
            let cropped = imageops::crop_imm(&sub, x1, y1, x2 - x1, y2 - y1).to_image();
            if let Some(score) = board_score(&cropped) {
                let (x, y) = (min_x as u32 + x1, min_y as u32 + y1);
                candidates.push(Found {
                    x,
                    y,
                    width: x2 - x1,
                    height: y2 - y1,
                    score,
                    image: imageops::crop_imm(image, x, y, x2 - x1, y2 - y1).to_image(),
                });
            }
        } else if fill >= 0.5 {
            // Seen at an angle: straighten the quadrilateral.
            let perimeter = arc_length(&hull, true);
            for eps in [0.015, 0.02, 0.03] {
                let quad = approximate_polygon_dp(&hull, eps * perimeter, true);
                if quad.len() == 4 && is_convex(&quad) {
                    if let Some(warped) = dewarp(image, &quad) {
                        if let Some(score) = board_score(&gray_of(&warped)) {
                            candidates.push(Found {
                                x: min_x as u32,
                                y: min_y as u32,
                                width: bw as u32,
                                height: bh as u32,
                                score,
                                image: warped,
                            });
                            break;
                        }
                    }
                }
            }
        }
    }

    if candidates.is_empty() {
        let ratio = width as f32 / height as f32;
        if (0.95..=1.05).contains(&ratio) {
            if let Some(score) = board_score(&gray) {
                return vec![Found { x: 0, y: 0, width, height, score, image: image.clone() }];
            }
        }
        return vec![];
    }

    // The same board is found several times: keep the best of overlapping ones.
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Found> = Vec::new();
    for c in candidates {
        if kept.iter().all(|k| iou(k, &c) <= 0.3) {
            kept.push(c);
        }
    }
    // Reading order: rows, then left to right.
    kept.sort_by_key(|b| (b.y / (b.height / 2).max(1), b.x));
    kept
}

fn iou(a: &Found, b: &Found) -> f32 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.width).min(b.x + b.width);
    let y2 = (a.y + a.height).min(b.y + b.height);
    if x2 <= x1 || y2 <= y1 {
        return 0.0;
    }
    let inter = ((x2 - x1) * (y2 - y1)) as f32;
    inter / ((a.width * a.height + b.width * b.height) as f32 - inter)
}

fn is_convex(quad: &[Point<i32>]) -> bool {
    let n = quad.len();
    let mut sign = 0i64;
    for i in 0..n {
        let (a, b, c) = (quad[i], quad[(i + 1) % n], quad[(i + 2) % n]);
        let cross = (b.x - a.x) as i64 * (c.y - b.y) as i64 - (b.y - a.y) as i64 * (c.x - b.x) as i64;
        if cross != 0 {
            if sign != 0 && cross.signum() != sign {
                return false;
            }
            sign = cross.signum();
        }
    }
    true
}

fn dewarp(image: &RgbImage, quad: &[Point<i32>]) -> Option<RgbImage> {
    let by = |f: &dyn Fn(&Point<i32>) -> i32, max: bool| {
        let it = quad.iter();
        let p = if max { it.max_by_key(|p| f(p)) } else { it.min_by_key(|p| f(p)) };
        p.map(|p| (p.x as f32, p.y as f32))
    };
    let top_left = by(&|p| p.x + p.y, false)?;
    let bottom_right = by(&|p| p.x + p.y, true)?;
    let top_right = by(&|p| p.y - p.x, false)?;
    let bottom_left = by(&|p| p.y - p.x, true)?;
    let s = WARPED as f32;
    let projection = Projection::from_control_points(
        [top_left, top_right, bottom_right, bottom_left],
        [(0.0, 0.0), (s, 0.0), (s, s), (0.0, s)],
    )?;
    let mut out = RgbImage::new(WARPED, WARPED);
    warp_into(image, &projection, Interpolation::Bicubic, Rgb([255, 255, 255]), &mut out);
    Some(out)
}

/// Trims a frame or coordinates around a board: the outer dark lines of the margins.
fn snap(gray: &GrayImage) -> (u32, u32, u32, u32) {
    let (w, h) = gray.dimensions();
    let (mx, my) = ((w as f32 * 0.15) as u32, (h as f32 * 0.15) as u32);
    if mx == 0 || my == 0 {
        return (0, 0, w, h);
    }
    let dark = |x: u32, y: u32| (gray.get_pixel(x, y)[0] < 120) as u32;
    let row = |y: u32| (mx..w - mx).map(|x| dark(x, y)).sum::<u32>() as f32 / (w - 2 * mx) as f32 > 0.45;
    let col = |x: u32| (my..h - my).map(|y| dark(x, y)).sum::<u32>() as f32 / (h - 2 * my) as f32 > 0.45;
    let top = (0..my).find(|&y| row(y)).unwrap_or(0);
    let bottom = (h - my..h).rev().find(|&y| row(y)).unwrap_or(h - 1);
    let left = (0..mx).find(|&x| col(x)).unwrap_or(0);
    let right = (w - mx..w).rev().find(|&x| col(x)).unwrap_or(w - 1);
    (left, top, right + 1, bottom + 1)
}

/// Mean of the pixels in each cell (like OpenCV's INTER_AREA when shrinking).
fn shrink(gray: &GrayImage, size: u32) -> Vec<f32> {
    let (w, h) = gray.dimensions();
    let mut out = vec![0.0; (size * size) as usize];
    for cy in 0..size {
        let (y0, y1) = (cy * h / size, ((cy + 1) * h / size).max(cy * h / size + 1));
        for cx in 0..size {
            let (x0, x1) = (cx * w / size, ((cx + 1) * w / size).max(cx * w / size + 1));
            let mut sum = 0u32;
            for y in y0..y1.min(h) {
                for x in x0..x1.min(w) {
                    sum += gray.get_pixel(x, y)[0] as u32;
                }
            }
            out[(cy * size + cx) as usize] = sum as f32 / ((y1.min(h) - y0) * (x1.min(w) - x0)).max(1) as f32;
        }
    }
    out
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

/// Whether the image looks like an 8x8 board (light and dark squares alternating,
/// or at least a grid of lines); the contrast is the score.
fn board_score(gray: &GrayImage) -> Option<f32> {
    if gray.width().min(gray.height()) < MIN_BOARD {
        return None;
    }
    let small = shrink(gray, 64);
    let mut light = Vec::new();
    let mut dark = Vec::new();
    for r in 0..8 {
        for c in 0..8 {
            let cell: Vec<f32> = (0..8)
                .flat_map(|y| (0..8).map(move |x| (r * 8 + y, c * 8 + x)))
                .map(|(y, x)| small[y * 64 + x])
                .collect();
            if (r + c) % 2 == 0 { light.push(median(cell)) } else { dark.push(median(cell)) }
        }
    }
    let contrast = (median(light) - median(dark)).abs();
    if contrast > 40.0 {
        return Some(contrast);
    }
    if contrast > 20.0 {
        let img = GrayImage::from_fn(64, 64, |x, y| Luma([small[(y * 64 + x) as usize].round() as u8]));
        let (dx, dy) = (horizontal_sobel(&img), vertical_sobel(&img));
        let gx: Vec<f32> = (0..64).map(|x| (0..64).map(|y| dx.get_pixel(x, y)[0].unsigned_abs() as f32).sum::<f32>() / 64.0).collect();
        let gy: Vec<f32> = (0..64).map(|y| (0..64).map(|x| dy.get_pixel(x, y)[0].unsigned_abs() as f32).sum::<f32>() / 64.0).collect();
        let mean = |v: &[f32], from: usize| (from..63).step_by(8).map(|i| v[i]).sum::<f32>() / (from..63).step_by(8).count() as f32;
        let ratio_x = mean(&gx, 7) / (mean(&gx, 3) + 1e-5);
        let ratio_y = mean(&gy, 7) / (mean(&gy, 3) + 1e-5);
        if ratio_x.min(ratio_y) > 1.3 {
            return Some(contrast);
        }
    }
    None
}

// --- Pieces ---

fn classify(model: &Model, board: &RgbImage) -> TractResult<(Vec<char>, Vec<f32>)> {
    let (w, h) = (board.width() as f32, board.height() as f32);
    let mut input = tract_ndarray::Array4::<f32>::zeros((64, 3, SQUARE as usize, SQUARE as usize));
    for row in 0..8 {
        for col in 0..8 {
            let (x0, y0) = ((col as f32 * w / 8.0) as u32, (row as f32 * h / 8.0) as u32);
            let (x1, y1) = (((col + 1) as f32 * w / 8.0) as u32, ((row + 1) as f32 * h / 8.0) as u32);
            let cell = imageops::crop_imm(board, x0, y0, (x1 - x0).max(1), (y1 - y0).max(1)).to_image();
            let cell = imageops::resize(&cell, SQUARE, SQUARE, imageops::FilterType::CatmullRom);
            for (x, y, p) in cell.enumerate_pixels() {
                for c in 0..3 {
                    input[[row * 8 + col, c, y as usize, x as usize]] = p[c] as f32 / 255.0;
                }
            }
        }
    }
    let out = model.run(tvec!(input.into_tensor().into()))?;
    let probs = out[0].to_array_view::<f32>()?;
    let mut squares = Vec::with_capacity(64);
    let mut confidence = Vec::with_capacity(64);
    for i in 0..64 {
        let (best, p) = (0..CLASSES.len())
            .map(|k| (k, probs[[i, k]]))
            .fold((6, f32::MIN), |a, b| if b.1 > a.1 { b } else { a });
        squares.push(CLASSES[best]);
        confidence.push(p);
    }
    Ok((squares, confidence))
}

/// White at the bottom when white pieces stand lower on average than black ones.
fn oriented(found: Found, mut squares: Vec<char>, mut confidence: Vec<f32>) -> ScannedBoard {
    let rows = |white: bool| -> Vec<f32> {
        squares
            .iter()
            .enumerate()
            .filter(|(_, c)| **c != '.' && c.is_ascii_uppercase() == white)
            .map(|(i, _)| (i / 8) as f32)
            .collect()
    };
    let (w, b) = (rows(true), rows(false));
    let avg = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let flipped = !w.is_empty() && !b.is_empty() && avg(&w) < avg(&b);
    if flipped {
        squares.reverse();
        confidence.reverse();
    }
    ScannedBoard {
        x: found.x,
        y: found.y,
        width: found.width,
        height: found.height,
        squares: squares.into_iter().collect(),
        confidence,
        flipped,
    }
}

fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    let data = data.split_once(',').map_or(data, |(head, rest)| if head.contains("base64") { rest } else { data });
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in data.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        acc = (acc << 6) | value(c).ok_or("Invalid image data")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        assert_eq!(decode_base64("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(decode_base64("data:image/png;base64,AAEC/w==").unwrap(), [0, 1, 2, 255]);
    }

    #[test]
    fn board_pattern() {
        let board = GrayImage::from_fn(200, 200, |x, y| Luma([if (x / 25 + y / 25) % 2 == 0 { 230 } else { 90 }]));
        assert!(board_score(&board).is_some());
        assert!(board_score(&GrayImage::from_pixel(200, 200, Luma([128]))).is_none());
    }

    /// Real diagrams (set SCAN_SAMPLES to a folder of `<placement with - for />.png`).
    #[test]
    fn samples() {
        let Ok(dir) = std::env::var("SCAN_SAMPLES") else { return };
        let model = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/vision/board-pieces.onnx");
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let expected = path.file_stem().unwrap().to_str().unwrap().replace('-', "/");
            let result = scan_bytes(&std::fs::read(&path).unwrap(), &model).unwrap();
            let got: Vec<String> = result.boards.iter().map(|b| placement(&b.squares)).collect();
            println!("{} -> {:?}", path.display(), got);
            assert!(got.contains(&expected), "{}", path.display());
        }
    }

    fn placement(squares: &str) -> String {
        squares
            .as_bytes()
            .chunks(8)
            .map(|row| {
                let mut s = String::new();
                let mut empty = 0;
                for &c in row {
                    if c == b'.' {
                        empty += 1;
                    } else {
                        if empty > 0 {
                            s += &empty.to_string();
                            empty = 0;
                        }
                        s.push(c as char);
                    }
                }
                if empty > 0 {
                    s += &empty.to_string();
                }
                s
            })
            .collect::<Vec<_>>()
            .join("/")
    }
}
