use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const MAX_CACHE_ENTRIES: usize = 150;

struct CachedIcon {
    data_uri: Option<String>,
    last_used: u64,
}

struct IconCache {
    entries: HashMap<String, CachedIcon>,
    counter: u64,
}

impl IconCache {
    fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(MAX_CACHE_ENTRIES),
            counter: 0,
        }
    }

    fn get(&mut self, key: &str) -> Option<Option<String>> {
        self.counter = self.counter.wrapping_add(1);
        let tick = self.counter;
        if let Some(entry) = self.entries.get_mut(key) {
            entry.last_used = tick;
            return Some(entry.data_uri.clone());
        }
        None
    }

    fn insert(&mut self, key: String, value: Option<String>) {
        if self.entries.len() >= MAX_CACHE_ENTRIES && !self.entries.contains_key(&key) {
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.last_used)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }
        self.counter = self.counter.wrapping_add(1);
        self.entries.insert(
            key,
            CachedIcon {
                data_uri: value,
                last_used: self.counter,
            },
        );
    }
}

fn cache() -> &'static Mutex<IconCache> {
    static CACHE: OnceLock<Mutex<IconCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(IconCache::new()))
}

pub fn get_process_icons(paths: Vec<String>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let mut missing = Vec::new();

    if let Ok(mut guard) = cache().lock() {
        for path in paths {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                continue;
            }
            let key = trimmed.to_lowercase();
            if let Some(cached) = guard.get(&key) {
                if let Some(uri) = cached {
                    result.insert(path, uri);
                }
            } else {
                missing.push((path, key));
            }
        }
    }

    // Extract missing icons outside the cache lock
    let mut extracted = Vec::with_capacity(missing.len());
    for (orig_path, key) in missing {
        let uri = extract_icon_data_uri(&orig_path);
        extracted.push((orig_path, key, uri));
    }

    if let Ok(mut guard) = cache().lock() {
        for (orig_path, key, uri) in extracted {
            if let Some(ref u) = uri {
                result.insert(orig_path, u.clone());
            }
            guard.insert(key, uri);
        }
    }

    result
}

#[cfg(windows)]
fn extract_icon_data_uri(exe_path: &str) -> Option<String> {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut shfi = SHFILEINFOW::default();
        let ret = SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON,
        );
        if ret == 0 || shfi.hIcon.is_invalid() {
            return None;
        }
        let hicon = shfi.hIcon;

        let mut icon_info = ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return None;
        }

        let png_opt = (|| -> Option<Vec<u8>> {
            let hbm_color = icon_info.hbmColor;
            let hbm_mask = icon_info.hbmMask;
            if hbm_color.is_invalid() {
                return None;
            }

            let mut bmp = BITMAP::default();
            if GetObjectW(
                hbm_color,
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut c_void),
            ) == 0
            {
                return None;
            }

            let width = bmp.bmWidth.max(0) as u32;
            let height = bmp.bmHeight.max(0) as u32;
            if width == 0 || height == 0 || width > 64 || height > 64 {
                return None;
            }

            let hdc = GetDC(None);
            if hdc.is_invalid() {
                return None;
            }

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32), // top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let pixel_bytes = (width * height * 4) as usize;
            let mut bgra = vec![0u8; pixel_bytes];
            let lines = GetDIBits(
                hdc,
                hbm_color,
                0,
                height,
                Some(bgra.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            if lines == 0 {
                let _ = ReleaseDC(None, hdc);
                return None;
            }

            // If all alpha values are 0 (legacy non-alpha icon), derive alpha from hbmMask
            let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
            if !has_alpha && !hbm_mask.is_invalid() {
                let mut mask_bgra = vec![0u8; pixel_bytes];
                let mask_lines = GetDIBits(
                    hdc,
                    hbm_mask,
                    0,
                    height,
                    Some(mask_bgra.as_mut_ptr() as *mut c_void),
                    &mut bmi,
                    DIB_RGB_COLORS,
                );
                if mask_lines > 0 {
                    for (px, mpx) in bgra.chunks_exact_mut(4).zip(mask_bgra.chunks_exact(4)) {
                        // In AND mask: white (0xFF) = transparent, black (0x00) = opaque
                        px[3] = if mpx[0] == 0 { 255 } else { 0 };
                    }
                } else {
                    for px in bgra.chunks_exact_mut(4) {
                        px[3] = 255;
                    }
                }
            }

            let _ = ReleaseDC(None, hdc);

            // Convert BGRA -> RGBA
            let mut rgba = bgra;
            for px in rgba.chunks_exact_mut(4) {
                px.swap(0, 2);
            }

            Some(encode_stored_png(width, height, &rgba))
        })();

        // Always free all GDI / Icon handles
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(icon_info.hbmColor);
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask);
        }
        let _ = DestroyIcon(hicon);

        png_opt.map(|png| format!("data:image/png;base64,{}", base64_encode(&png)))
    }
}

#[cfg(not(windows))]
fn extract_icon_data_uri(_exe_path: &str) -> Option<String> {
    None
}

// ============================================================================
// Pure-Rust Stored-PNG (uncompressed DEFLATE + CRC32 + Adler32) & Base64
// ============================================================================
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

fn push_png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], payload: &[u8]) {
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(chunk_type);
    out.extend_from_slice(payload);
    let checksum = crc32(&out[start..]);
    out.extend_from_slice(&checksum.to_be_bytes());
}

fn encode_stored_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let row_bytes = (width as usize) * 4;
    let mut raw = Vec::with_capacity((row_bytes + 1) * (height as usize));
    for y in 0..(height as usize) {
        raw.push(0u8); // Filter type 0 (None)
        let start = y * row_bytes;
        raw.extend_from_slice(&rgba[start..start + row_bytes]);
    }

    // Zlib header (0x78 0x01 = no compression / stored) + uncompressed DEFLATE blocks + Adler32
    let mut zlib = Vec::with_capacity(raw.len() + 32);
    zlib.push(0x78);
    zlib.push(0x01);

    let mut offset = 0usize;
    while offset < raw.len() {
        let remaining = raw.len() - offset;
        let block_len = remaining.min(65535);
        let is_final = offset + block_len >= raw.len();
        zlib.push(if is_final { 0x01 } else { 0x00 });
        let len_u16 = block_len as u16;
        let nlen_u16 = !len_u16;
        zlib.extend_from_slice(&len_u16.to_le_bytes());
        zlib.extend_from_slice(&nlen_u16.to_le_bytes());
        zlib.extend_from_slice(&raw[offset..offset + block_len]);
        offset += block_len;
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut png = Vec::with_capacity(zlib.len() + 64);
    png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    push_png_chunk(&mut png, b"IHDR", &ihdr);
    push_png_chunk(&mut png, b"IDAT", &zlib);
    push_png_chunk(&mut png, b"IEND", &[]);
    png
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
