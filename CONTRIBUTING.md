# Contributing to Spektr Taskmanager

Thank you for your interest in contributing to **Spektr Taskmanager**! Contributions of all kinds — bug reports, hardware telemetry feedback, translations, documentation improvements, and pull requests — are welcome.

## Prerequisites

- **Windows 10 / 11 (x64)**
- **Node.js** (v20 or v22 LTS) & **pnpm**
- **Rust toolchain** (`rustup`, `cargo`, `rustc`)
- **Visual Studio C++ Build Tools** (MSVC)

## Local Development Setup

```powershell
# 1. Fork & clone the repository
git clone https://github.com/<your-username>/spektr-taskmanager.git
cd spektr-taskmanager

# 2. Install frontend dependencies
pnpm install

# 3. Start the dev app (Vite HMR + native Tauri window)
pnpm tauri dev
```

## Before Opening a Pull Request

Please verify your changes compile cleanly:

```powershell
# TypeScript typecheck & Vite production bundle
pnpm build

# Rust check & lints
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
```

### Guidelines
- Keep pull requests focused on a single feature, fix, or refactor.
- For UI strings, update both English ([src/i18n/en.ts](src/i18n/en.ts)) and German ([src/i18n/de.ts](src/i18n/de.ts)) dictionaries.
- Keep Win32 `unsafe` blocks minimal, well-commented, and free of handle/memory leaks.
- Do not bundle third-party binaries or kernel drivers.

## Reporting Bugs

Hardware telemetry on Windows varies across CPUs, GPUs, and Windows builds. When reporting a bug, please use the **Bug Report** issue template and include your Windows version, GPU vendor, and whether Spektr was running as Administrator.
