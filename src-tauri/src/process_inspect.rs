use crate::models::{
    ProcessEnvInfo, ProcessModuleEntry, ProcessModulesThreads, ProcessSecurityInfo,
    ProcessThreadEntry,
};
use std::io::Read;

// ============================================================================
// Pure-Rust Streaming SHA-256 (zero external crate dependencies)
// ============================================================================
struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(Self::K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                Self::compress(&mut self.state, &block);
                self.buf_len = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            Self::compress(&mut self.state, &block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.total_len.wrapping_mul(8);
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            self.buf[self.buf_len..64].fill(0);
            let block = self.buf;
            Self::compress(&mut self.state, &block);
            self.buf_len = 0;
        }
        self.buf[self.buf_len..56].fill(0);
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        Self::compress(&mut self.state, &block);

        let mut hex = String::with_capacity(64);
        for word in self.state {
            use std::fmt::Write;
            let _ = write!(&mut hex, "{word:08x}");
        }
        hex
    }
}

fn compute_file_sha256(path: &str) -> Result<(String, u64), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Datei konnte nicht geöffnet werden: {e}"))?;
    let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Fehler beim Lesen der Datei: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok((hasher.finalize_hex(), file_size))
}

// ============================================================================
// Security Info (SHA-256 + Version Info + Authenticode via WinVerifyTrust)
// ============================================================================
pub fn get_process_security_info(exe_path: &str) -> Result<ProcessSecurityInfo, String> {
    let trimmed = exe_path.trim();
    if trimmed.is_empty() {
        return Err("Kein Dateipfad für diesen Prozess verfügbar.".into());
    }

    let (sha256, file_size) = compute_file_sha256(trimmed)?;
    let (company_name, file_description, file_version) = query_version_info(trimmed);
    let (signed, signature_status) = verify_authenticode_signature(trimmed);
    let virustotal_url = format!("https://www.virustotal.com/gui/file/{sha256}");

    Ok(ProcessSecurityInfo {
        exe_path: trimmed.to_string(),
        sha256,
        file_size,
        company_name,
        file_description,
        file_version,
        signed,
        signature_status,
        virustotal_url,
    })
}

#[cfg(windows)]
fn query_version_info(exe_path: &str) -> (Option<String>, Option<String>, Option<String>) {
    use std::ffi::c_void;
    use windows::core::{s, w};
    use windows::Win32::Foundation::FreeLibrary;
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    type GetFileVersionInfoSizeWFn = unsafe extern "system" fn(*const u16, *mut u32) -> u32;
    type GetFileVersionInfoWFn =
        unsafe extern "system" fn(*const u16, u32, u32, *mut c_void) -> i32;
    type VerQueryValueWFn =
        unsafe extern "system" fn(*const c_void, *const u16, *mut *mut c_void, *mut u32) -> i32;

    unsafe {
        let Ok(lib) = LoadLibraryW(w!("version.dll")) else {
            return (None, None, None);
        };

        let result = (|| {
            let size_fn: GetFileVersionInfoSizeWFn =
                std::mem::transmute(GetProcAddress(lib, s!("GetFileVersionInfoSizeW"))?);
            let info_fn: GetFileVersionInfoWFn =
                std::mem::transmute(GetProcAddress(lib, s!("GetFileVersionInfoW"))?);
            let query_fn: VerQueryValueWFn =
                std::mem::transmute(GetProcAddress(lib, s!("VerQueryValueW"))?);

            let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
            let mut handle: u32 = 0;
            let len = size_fn(wide_path.as_ptr(), &mut handle);
            if len == 0 {
                return None;
            }

            let mut data = vec![0u8; len as usize];
            if info_fn(wide_path.as_ptr(), 0, len, data.as_mut_ptr() as *mut c_void) == 0 {
                return None;
            }

            // Read translation table (lang + codepage), fallback to US-English Unicode (040904B0)
            let trans_query: Vec<u16> = "\\VarFileInfo\\Translation"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut trans_ptr: *mut c_void = std::ptr::null_mut();
            let mut trans_len: u32 = 0;
            let (lang, codepage) = if query_fn(
                data.as_ptr() as *const c_void,
                trans_query.as_ptr(),
                &mut trans_ptr,
                &mut trans_len,
            ) != 0
                && !trans_ptr.is_null()
                && trans_len >= 4
            {
                let pair = std::slice::from_raw_parts(trans_ptr as *const u16, 2);
                (pair[0], pair[1])
            } else {
                (0x0409u16, 0x04B0u16)
            };

            let read_str = |field: &str| -> Option<String> {
                let sub = format!("\\StringFileInfo\\{lang:04x}{codepage:04x}\\{field}");
                let wide_sub: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
                let mut val_ptr: *mut c_void = std::ptr::null_mut();
                let mut val_len: u32 = 0;
                if query_fn(
                    data.as_ptr() as *const c_void,
                    wide_sub.as_ptr(),
                    &mut val_ptr,
                    &mut val_len,
                ) != 0
                    && !val_ptr.is_null()
                    && val_len > 0
                {
                    let slice = std::slice::from_raw_parts(val_ptr as *const u16, val_len as usize);
                    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
                    let s = String::from_utf16_lossy(&slice[..end]).trim().to_string();
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
                None
            };

            Some((
                read_str("CompanyName"),
                read_str("FileDescription"),
                read_str("FileVersion"),
            ))
        })();

        let _ = FreeLibrary(lib);
        result.unwrap_or((None, None, None))
    }
}

#[cfg(not(windows))]
fn query_version_info(_exe_path: &str) -> (Option<String>, Option<String>, Option<String>) {
    (None, None, None)
}

#[cfg(windows)]
fn verify_authenticode_signature(exe_path: &str) -> (bool, String) {
    use std::ffi::c_void;
    use windows::core::{s, w, GUID};
    use windows::Win32::Foundation::{FreeLibrary, HWND};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    #[repr(C)]
    struct WinTrustFileInfo {
        cb_struct: u32,
        pcwsz_file_path: *const u16,
        h_file: *mut c_void,
        pg_known_subject: *const GUID,
    }

    #[repr(C)]
    struct WinTrustData {
        cb_struct: u32,
        p_policy_callback_data: *mut c_void,
        p_sip_client_data: *mut c_void,
        dw_ui_choice: u32,
        fdw_revocation_checks: u32,
        dw_union_choice: u32,
        p_file: *mut WinTrustFileInfo,
        dw_state_action: u32,
        h_wvt_state_data: *mut c_void,
        pwsz_url_reference: *const u16,
        dw_prov_flags: u32,
        dw_ui_context: u32,
        p_signature_settings: *mut c_void,
    }

    type WinVerifyTrustFn =
        unsafe extern "system" fn(HWND, *mut GUID, *mut c_void) -> i32;

    const WTD_UI_NONE: u32 = 2;
    const WTD_REVOKE_NONE: u32 = 0;
    const WTD_CHOICE_FILE: u32 = 1;
    const WTD_STATEACTION_VERIFY: u32 = 1;
    const WTD_STATEACTION_CLOSE: u32 = 2;
    const WTD_CACHE_ONLY_URL_RETRIEVAL: u32 = 0x00001000;

    // WINTRUST_ACTION_GENERIC_VERIFY_V2: {00AAC56B-CD44-11d0-8CC2-00C04FC295EE}
    let mut action_guid = GUID::from_values(
        0x00AAC56B,
        0xCD44,
        0x11d0,
        [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE],
    );

    unsafe {
        let Ok(lib) = LoadLibraryW(w!("wintrust.dll")) else {
            return (false, "Prüfung nicht verfügbar".to_string());
        };
        let Some(fn_ptr) = GetProcAddress(lib, s!("WinVerifyTrust")) else {
            let _ = FreeLibrary(lib);
            return (false, "Prüfung nicht verfügbar".to_string());
        };
        let verify_fn: WinVerifyTrustFn = std::mem::transmute(fn_ptr);

        let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut file_info = WinTrustFileInfo {
            cb_struct: std::mem::size_of::<WinTrustFileInfo>() as u32,
            pcwsz_file_path: wide_path.as_ptr(),
            h_file: std::ptr::null_mut(),
            pg_known_subject: std::ptr::null(),
        };

        let mut trust_data = WinTrustData {
            cb_struct: std::mem::size_of::<WinTrustData>() as u32,
            p_policy_callback_data: std::ptr::null_mut(),
            p_sip_client_data: std::ptr::null_mut(),
            dw_ui_choice: WTD_UI_NONE,
            fdw_revocation_checks: WTD_REVOKE_NONE,
            dw_union_choice: WTD_CHOICE_FILE,
            p_file: &mut file_info,
            dw_state_action: WTD_STATEACTION_VERIFY,
            h_wvt_state_data: std::ptr::null_mut(),
            pwsz_url_reference: std::ptr::null(),
            dw_prov_flags: WTD_CACHE_ONLY_URL_RETRIEVAL,
            dw_ui_context: 0,
            p_signature_settings: std::ptr::null_mut(),
        };

        let status = verify_fn(
            HWND::default(),
            &mut action_guid,
            &mut trust_data as *mut _ as *mut c_void,
        );

        // Always close state data to avoid handle/memory leaks
        trust_data.dw_state_action = WTD_STATEACTION_CLOSE;
        let _ = verify_fn(
            HWND::default(),
            &mut action_guid,
            &mut trust_data as *mut _ as *mut c_void,
        );

        let _ = FreeLibrary(lib);

        let code = status as u32;
        match code {
            0 => (true, "Gültig signiert".to_string()),
            0x800B0100 => (false, "Nicht signiert".to_string()),
            0x800B0101 => (false, "Zertifikat abgelaufen".to_string()),
            0x80096010 => (false, "Signatur beschädigt".to_string()),
            0x800B0109 => (false, "Nicht vertrauenswürdig".to_string()),
            0x800B010C => (false, "Zertifikat widerrufen".to_string()),
            _ => (false, format!("Ungültig (0x{code:08X})")),
        }
    }
}

#[cfg(not(windows))]
fn verify_authenticode_signature(_exe_path: &str) -> (bool, String) {
    (false, "Nicht unterstützt".to_string())
}

// ============================================================================
// Modules & Threads (CreateToolhelp32Snapshot)
// ============================================================================
#[cfg(windows)]
pub fn get_process_modules_and_threads(pid: u32) -> Result<ProcessModulesThreads, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, Thread32First, Thread32Next,
        MODULEENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32, TH32CS_SNAPTHREAD, THREADENTRY32,
    };

    const MAX_ITEMS: usize = 500;
    let mut modules = Vec::new();
    let mut total_modules = 0usize;
    let mut threads = Vec::new();
    let mut total_threads = 0usize;

    unsafe {
        // Modules snapshot (may fail with ERROR_ACCESS_DENIED on protected/elevated processes)
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) {
            let mut me = MODULEENTRY32W {
                dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
                ..Default::default()
            };
            if Module32FirstW(snap, &mut me).is_ok() {
                loop {
                    total_modules += 1;
                    if modules.len() < MAX_ITEMS {
                        let name = utf16_to_string(&me.szModule);
                        let path = utf16_to_string(&me.szExePath);
                        modules.push(ProcessModuleEntry {
                            name,
                            path,
                            size_bytes: me.modBaseSize as u64,
                        });
                    }
                    if Module32NextW(snap, &mut me).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }

        // Threads snapshot (system-wide, filtered by th32OwnerProcessID)
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) {
            let mut te = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            if Thread32First(snap, &mut te).is_ok() {
                loop {
                    if te.th32OwnerProcessID == pid {
                        total_threads += 1;
                        if threads.len() < MAX_ITEMS {
                            threads.push(ProcessThreadEntry {
                                tid: te.th32ThreadID,
                                base_priority: te.tpBasePri,
                            });
                        }
                    }
                    if Thread32Next(snap, &mut te).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
    }

    modules.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(ProcessModulesThreads {
        modules,
        threads,
        total_modules,
        total_threads,
    })
}

#[cfg(not(windows))]
pub fn get_process_modules_and_threads(_pid: u32) -> Result<ProcessModulesThreads, String> {
    Ok(ProcessModulesThreads {
        modules: Vec::new(),
        threads: Vec::new(),
        total_modules: 0,
        total_threads: 0,
    })
}

#[cfg(windows)]
fn utf16_to_string(slice: &[u16]) -> String {
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..end])
}

// ============================================================================
// Environment & CWD (PEB -> RTL_USER_PROCESS_PARAMETERS via ReadProcessMemory)
// ============================================================================
#[cfg(windows)]
pub fn get_process_env_info(pid: u32) -> Result<ProcessEnvInfo, String> {
    use std::ffi::c_void;
    use windows::core::{s, w};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    const MAX_ENV_VARS: usize = 200;
    const MAX_ENV_BYTES: usize = 256 * 1024;

    #[repr(C)]
    #[derive(Default)]
    struct ProcessBasicInformation {
        reserved1: usize,
        peb_base_address: usize,
        reserved2: [usize; 2],
        unique_process_id: usize,
        reserved3: usize,
    }

    #[repr(C)]
    #[derive(Default, Copy, Clone)]
    struct UnicodeString64 {
        length: u16,
        maximum_length: u16,
        _pad: u32,
        buffer: usize,
    }

    type NtQueryInformationProcessFn = unsafe extern "system" fn(
        HANDLE,
        u32,
        *mut c_void,
        u32,
        *mut u32,
    ) -> i32;

    unsafe {
        let ntdll = GetModuleHandleW(w!("ntdll.dll"))
            .map_err(|_| "ntdll.dll konnte nicht geladen werden.".to_string())?;
        let proc_ptr = GetProcAddress(ntdll, s!("NtQueryInformationProcess"))
            .ok_or_else(|| "NtQueryInformationProcess nicht verfügbar.".to_string())?;
        let nt_query: NtQueryInformationProcessFn = std::mem::transmute(proc_ptr);

        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            .map_err(|e| {
                format!(
                    "Zugriff auf Prozessspeicher für PID {pid} verweigert (evtl. Adminrechte nötig): {e}"
                )
            })?;

        let read_mem = |addr: usize, buf: &mut [u8]| -> bool {
            if addr == 0 || buf.is_empty() {
                return false;
            }
            let mut bytes_read: usize = 0;
            ReadProcessMemory(
                handle,
                addr as *const c_void,
                buf.as_mut_ptr() as *mut c_void,
                buf.len(),
                Some(&mut bytes_read),
            )
            .is_ok()
                && bytes_read > 0
        };

        let result = (|| -> Result<ProcessEnvInfo, String> {
            let mut pbi = ProcessBasicInformation::default();
            let mut ret_len: u32 = 0;
            let status = nt_query(
                handle,
                0, // ProcessBasicInformation
                &mut pbi as *mut _ as *mut c_void,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                &mut ret_len,
            );
            if status < 0 || pbi.peb_base_address == 0 {
                return Err("PEB-Adresse konnte nicht ausgelesen werden.".into());
            }

            // Read ProcessParameters pointer from x64 PEB (offset 0x20)
            let mut params_ptr_bytes = [0u8; std::mem::size_of::<usize>()];
            if !read_mem(pbi.peb_base_address + 0x20, &mut params_ptr_bytes) {
                return Err("PEB ProcessParameters nicht lesbar.".into());
            }
            let params_ptr = usize::from_ne_bytes(params_ptr_bytes);
            if params_ptr == 0 {
                return Err("ProcessParameters ist leer.".into());
            }

            // Read CurrentDirectory.DosPath (offset 0x38 in x64 RTL_USER_PROCESS_PARAMETERS)
            let mut cwd_us_bytes = [0u8; std::mem::size_of::<UnicodeString64>()];
            let cwd = if read_mem(params_ptr + 0x38, &mut cwd_us_bytes) {
                let us: UnicodeString64 =
                    std::ptr::read_unaligned(cwd_us_bytes.as_ptr() as *const UnicodeString64);
                let byte_len = (us.length as usize).min(4096);
                if byte_len >= 2 && us.buffer != 0 {
                    let mut raw = vec![0u8; byte_len];
                    if read_mem(us.buffer, &mut raw) {
                        let u16s: Vec<u16> = raw
                            .chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect();
                        let s = utf16_to_string(&u16s).trim().to_string();
                        if s.is_empty() { None } else { Some(s) }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            // Read Environment pointer (offset 0x80) and EnvironmentSize (offset 0x3F0 on Win8+ x64)
            let mut env_ptr_bytes = [0u8; std::mem::size_of::<usize>()];
            if !read_mem(params_ptr + 0x80, &mut env_ptr_bytes) {
                return Ok(ProcessEnvInfo {
                    cwd,
                    env_vars: Vec::new(),
                    truncated: false,
                });
            }
            let env_ptr = usize::from_ne_bytes(env_ptr_bytes);
            if env_ptr == 0 {
                return Ok(ProcessEnvInfo {
                    cwd,
                    env_vars: Vec::new(),
                    truncated: false,
                });
            }

            let mut env_size_bytes = [0u8; std::mem::size_of::<usize>()];
            let declared_size = if read_mem(params_ptr + 0x3F0, &mut env_size_bytes) {
                usize::from_ne_bytes(env_size_bytes)
            } else {
                0
            };
            let target_bytes = if declared_size >= 4 && declared_size <= MAX_ENV_BYTES {
                declared_size
            } else {
                64 * 1024
            };

            // Read environment block in 4 KB chunks until double-null or target_bytes
            let mut env_u16: Vec<u16> = Vec::new();
            let mut offset = 0usize;
            let mut chunk = [0u8; 4096];
            let mut reached_end = false;
            while offset < target_bytes && !reached_end {
                let to_read = (target_bytes - offset).min(chunk.len());
                let mut bytes_read: usize = 0;
                let ok = ReadProcessMemory(
                    handle,
                    (env_ptr + offset) as *const c_void,
                    chunk.as_mut_ptr() as *mut c_void,
                    to_read,
                    Some(&mut bytes_read),
                )
                .is_ok();
                if !ok || bytes_read < 2 {
                    break;
                }
                for pair in chunk[..bytes_read].chunks_exact(2) {
                    let val = u16::from_le_bytes([pair[0], pair[1]]);
                    if val == 0 && env_u16.last() == Some(&0) {
                        reached_end = true;
                        break;
                    }
                    env_u16.push(val);
                }
                offset += bytes_read;
            }

            let mut env_vars = Vec::new();
            let mut truncated = false;
            for entry in env_u16.split(|&c| c == 0) {
                if entry.is_empty() {
                    continue;
                }
                let s = String::from_utf16_lossy(entry);
                // Skip hidden drive variables like "=C:=C:\..."
                if s.starts_with('=') {
                    continue;
                }
                if let Some((k, v)) = s.split_once('=') {
                    if !k.is_empty() {
                        if env_vars.len() >= MAX_ENV_VARS {
                            truncated = true;
                            break;
                        }
                        env_vars.push((k.to_string(), v.to_string()));
                    }
                }
            }
            env_vars.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

            Ok(ProcessEnvInfo {
                cwd,
                env_vars,
                truncated,
            })
        })();

        let _ = CloseHandle(handle);
        result
    }
}

#[cfg(not(windows))]
pub fn get_process_env_info(_pid: u32) -> Result<ProcessEnvInfo, String> {
    Ok(ProcessEnvInfo {
        cwd: None,
        env_vars: Vec::new(),
        truncated: false,
    })
}
