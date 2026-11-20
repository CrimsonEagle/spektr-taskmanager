/// Pure-Rust 16x16 RGBA live CPU history chart renderer for the Windows system tray icon.
/// Renders in < 10 µs with 1024 bytes output and zero disk I/O.

pub fn quantize_cpu_bar(cpu_percent: f32) -> u8 {
    let clamped = cpu_percent.clamp(0.0, 100.0);
    if clamped < 1.0 {
        0
    } else {
        ((clamped / 100.0) * 14.0).round().clamp(1.0, 14.0) as u8
    }
}

pub fn cpu_color_bucket(cpu_percent: f32) -> u8 {
    if cpu_percent > 85.0 {
        2 // Red
    } else if cpu_percent >= 60.0 {
        1 // Amber
    } else {
        0 // Green
    }
}

pub fn render_cpu_tray_icon(history: &[u8; 14], current_cpu: f32) -> Vec<u8> {
    const W: usize = 16;
    const H: usize = 16;
    let mut rgba = vec![0u8; W * H * 4];

    let border: [u8; 4] = [56, 66, 82, 255];
    let bg: [u8; 4] = [15, 20, 28, 242];
    let grid: [u8; 4] = [30, 40, 54, 245];

    let (fill, top_edge): ([u8; 4], [u8; 4]) = match cpu_color_bucket(current_cpu) {
        2 => ([239, 68, 68, 240], [252, 165, 165, 255]), // Red
        1 => ([245, 158, 11, 238], [253, 224, 71, 255]), // Amber
        _ => ([34, 197, 94, 232], [134, 239, 172, 255]), // Green
    };

    let set_px = |buf: &mut [u8], x: usize, y: usize, color: [u8; 4]| {
        let idx = (y * W + x) * 4;
        buf[idx..idx + 4].copy_from_slice(&color);
    };

    // Draw border + dark background + subtle 50% horizontal guide line
    for y in 0..H {
        for x in 0..W {
            let color = if x == 0 || x == W - 1 || y == 0 || y == H - 1 {
                border
            } else if y == 8 {
                grid
            } else {
                bg
            };
            set_px(&mut rgba, x, y, color);
        }
    }

    // Draw 14 vertical 1px columns (x = 1..=14, y = 1..=14)
    for (col, &bar_h) in history.iter().enumerate() {
        let h = (bar_h as usize).min(14);
        if h == 0 {
            continue;
        }
        let x = col + 1;
        let top_y = 15 - h; // h=1 -> y=14, h=14 -> y=1
        set_px(&mut rgba, x, top_y, top_edge);
        for y in (top_y + 1)..=14 {
            set_px(&mut rgba, x, y, fill);
        }
    }

    rgba
}
