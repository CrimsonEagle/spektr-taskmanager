# Spektr Taskmanager — Modern Windows Task Manager

**Spektr Taskmanager** is a fast, lightweight, and visually refined Task Manager & system monitor for Windows 10/11 built with **Tauri v2**, **Rust**, **React 19**, **TypeScript**, **Tailwind CSS v4**, **Framer Motion**, and **Phosphor Duotone Icons**.

Designed to deliver power-user insight without visual clutter, Spektr pairs native Windows kernel telemetry with a system-aligned Fluent UI (automatic Light & Dark Mode), semantic spectral color coding, and smooth 60 fps animations — all packed into a ~1.5 MB native Windows installer.

> **Current Version:** `v0.2.0`

---

## Design Philosophy

- **System-Aligned Light & Dark Mode:** Follows your Windows appearance setting automatically, with a one-click switcher in the title bar (`System` / `Light` / `Dark`).
- **Semantic Color Coding:** Each subsystem has a distinct, high-contrast accent color tuned for both light and dark themes:
  - **CPU** — Sky / Cyan
  - **RAM** — Violet
  - **GPU** — Emerald
  - **Disk** — Amber
  - **Network** — Coral / Rose
- **Progressive Disclosure:** Keep day-to-day views clean and scannable while deep diagnostics (command line, paths, threads, handles, child processes, open ports, priority, EcoQoS) slide out smoothly on demand in a right-hand **Process Inspector**.
- **Zero-Jitter Telemetry:** Tabular numerals, fixed-width live metric tabs, and **Hover-Freeze** on process tables ensure nothing jumps under your cursor.

---

## Features

### 1. Spektr Overview (Dashboard)
A single-glance system health Bento grid:
- **CPU Card:** Total usage %, clock speed (GHz), core/thread count, temperature (when exposed), live sparkline, and a real-time **Per-Core Heatmap**.
- **RAM Card:** Used/total memory, segmented Active vs. Cached/Standby bar, free memory, and Swap/Pagefile usage.
- **GPU Card:** Adapter name, utilization %, VRAM usage bar, temperature (°C), and power draw (W) via `nvidia-smi` for NVIDIA GPUs plus native DXGI + Windows PDH counters for AMD & Intel GPUs.
- **Disk Card:** Live aggregate Read/Write throughput, sparkline, and mounted volume capacity bars.
- **Network Card:** Live Download/Upload speeds, primary interface, open listening port count, and session totals.
- **System / Battery & Quick Actions:** Battery percentage and AC/charging status (on laptops) or uptime & process count, plus quick shortcuts to Open Ports, File Lock Finder, and **Restart Windows Explorer**.
- **Top Consumers Spotlight & Spike Alerts:** Top 5 CPU & RAM consumers and clickable banners for recently detected load spikes.

### 2. Smart Process Manager
- **Three View Modes:**
  - **Grouped View:** Aggregates multi-process apps (e.g., Chrome, Edge, VS Code, Discord, `svchost.exe`) into expandable rows with combined CPU, RAM, and Disk I/O totals.
  - **Tree View:** Visual Parent → Child hierarchy ideal for developers inspecting terminal, Node.js, or Python process trees.
  - **Flat List:** Classic sortable process table.
- **Hover-Freeze:** Hovering over the table automatically freezes row ordering while live metrics and sparklines continue updating — eliminating accidental misclicks on shifting rows. Includes a manual Lock/Unlock toggle.
- **Inline 30s Sparklines & Smart Context:** Every process row shows a 30-second CPU trend sparkline, color-coded category badge (`Browser`, `Dev`, `App`, `Game/3D`, `Background`, `System`), and human-readable subtitles extracted from command lines (e.g., script names for `node.exe`/`python.exe`, service names for `svchost.exe`, or renderer/GPU roles for browsers).
- **Slide-In Process Inspector:** Click any process to inspect and control it:
  - **End Process** & **Kill Process Tree** (terminates all descendants cleanly)
  - **Suspend / Resume (Freeze):** Pause a process's CPU execution via `NtSuspendProcess` / `NtResumeProcess` without killing it
  - **Windows 11 Efficiency Mode (EcoQoS):** Toggle `ProcessPowerThrottling` + idle priority directly
  - **Priority Class Selector:** Idle, Below Normal, Normal, Above Normal, High
  - **Open File Location** in Windows Explorer
  - Live 30s CPU sparkline, RAM, Disk I/O rates & totals, **Thread & Handle counts**, clickable **Parent & Child processes**, copyable executable path & full command line, and all **open network ports** owned by that PID.

### 3. Performance & Time-Range Spike Analytics
- **15-Minute Telemetry Ring Buffer:** Records per-second snapshots for `1 Min`, `5 Min`, and `15 Min` windows across **CPU, RAM, GPU, Disk I/O, and Network**.
- **Interactive Range Selection:** Click a single point or **click-and-drag across any time interval** on the chart to highlight a range and compute exact **Average (`Ø`) and Peak (`Max`)** statistics across that exact window.
- **Per-Metric Top Process Breakdown ("What just happened?"):** Every resource tab shows its own matching top processes — both live and aggregated over any selected range:
  - **CPU:** Exact kernel-level CPU % via `NtQuerySystemInformation(SystemProcessInformation)` + `GetSystemTimes` (accurately attributes `System`, Windows Defender, services, elevated apps, and newly spawned burst processes without `OpenProcess` gaps; transparently reports any sub-second exited processes / kernel interrupts).
  - **RAM:** Working set usage (`Ø` & `Peak`).
  - **GPU:** Real per-process GPU engine utilization via persistent Windows PDH counters (`\GPU Engine(*)\Utilization Percentage`) across NVIDIA, AMD, and Intel.
  - **Disk:** Real per-process Read + Write throughput (`ReadTransferCount` + `WriteTransferCount`) for all processes including System & protected processes.
  - **Network:** Most active processes by live `ESTABLISHED` connections and listening ports.
- **Automatic Spike Detection:** Highlights recent spikes directly on the chart and as clickable chips that automatically focus a window around the spike.

### 4. Network & Open Ports
- Live network adapter cards (IPv4/IPv6, live Rx/Tx speeds, session totals).
- Native IPv4/IPv6 TCP & UDP connection table via Windows IP Helper (`GetExtendedTcpTable` / `GetExtendedUdpTable`).
- Filter between **Listening (Open Ports)** and **All Connections**, search by port (e.g. `:3000`, `:5173`, `:8080`), highlight common developer ports, inspect the owning process, or kill a stuck port owner in one click.

### 5. System & Tools
- **Startup Manager:** Enumerates `HKCU\...\Run`, `HKLM\...\Run`, `WOW6432Node`, and the user Startup folder, with live Enable/Disable toggles backed by Windows `StartupApproved`.
- **Windows Services:** Searchable, filterable list of Windows services via the native Service Control Manager (`OpenSCManagerW` / `EnumServicesStatusExW`) with Start, Stop, and Restart controls.
- **File Lock Finder ("Who is locking this file?"):** Pick or paste any file path to query the native **Windows Restart Manager API** (`RmStartSession` / `RmRegisterResources` / `RmGetList`) and immediately see — and optionally close — every process holding a lock on that file.

### 6. Auto-Enforced Quick Profiles (`Normal` / `Eco` / `Boost`)
Accessible right from the sidebar and continuously enforced in the background on newly launched processes:
- **Normal:** Restores all profile-managed processes back to standard priority and disables Efficiency Mode.
- **Eco:** Automatically applies Windows 11 Efficiency Mode (EcoQoS) to running and newly launched browser & background processes.
- **Boost (Gaming):** Deprioritizes background tasks (`Below Normal`) and promotes games & active 3D applications to `High` priority — automatically detecting newly started games via known library paths (Steam, Epic, Riot, Xbox, GOG, Ubisoft, EA) **and** live sustained GPU load (`≥ 15% GPU`).

### 7. Command Palette (`Ctrl + K`), Mini-HUD & System Tray
- **Command Palette (`Ctrl + K`):** Instantly search processes, look up ports (`:3000`), switch views, toggle themes, apply profiles, or restart Windows Explorer from the keyboard.
- **Always-on-Top Mini-HUD:** Shrinks Spektr into a compact floating HUD displaying live CPU, RAM, GPU bars, network speeds, and the top CPU consumer.
- **System Tray:** Quick access menu to show/focus Spektr, toggle Mini-HUD, or exit.

---

## Architecture & Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Desktop Shell** | Tauri v2 (WebView2 on Windows, custom frameless title bar, native system tray) |
| **Backend** | Rust (`sysinfo`, `tokio`, `windows` crate v0.58) |
| **Native Windows APIs** | `NtQuerySystemInformation`, `GetSystemTimes`, `PDH` (`GPU Engine`), `DXGI`, `GetExtendedTcpTable` / `GetExtendedUdpTable`, `RestartManager` (`RmGetList`), `NtSuspendProcess` / `NtResumeProcess`, `SetProcessInformation` (`ProcessPowerThrottling`), `SCManager`, Win32 Registry, `GetSystemPowerStatus` |
| **Frontend** | React 19, TypeScript, Vite 6, Tailwind CSS v4, Framer Motion, Phosphor Icons (Duotone) |

---

## Development & Building

### Prerequisites
- **Windows 10 / 11 (x64)**
- **Node.js** & **pnpm**
- **Rust toolchain** (`rustup`, `cargo`, `rustc`)
- **Visual Studio C++ Build Tools** (MSVC)

### Commands

```powershell
# Install frontend dependencies
pnpm install

# Run in development mode (Vite HMR + native Tauri window)
pnpm tauri dev

# Build optimized standalone executable and Windows installers (NSIS .exe & .msi)
pnpm tauri build
```

### Build Outputs
After running `pnpm tauri build`, you will find:
- **Windows Setup Installer (recommended):** `src-tauri/target/release/bundle/nsis/Spektr Taskmanager_<version>_x64-setup.exe`
- **Windows MSI Installer:** `src-tauri/target/release/bundle/msi/Spektr Taskmanager_<version>_x64_en-US.msi`
- **Standalone Portable Executable:** `src-tauri/target/release/spektr-taskmanager.exe`
