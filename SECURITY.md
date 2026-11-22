# Security Policy

## Supported Versions

Security fixes are provided for the latest release on the `main` branch.

| Version | Supported |
| :--- | :--- |
| `0.3.x` (latest) | Yes |
| `< 0.3.0` | No |

## Reporting a Vulnerability

Because Spektr Taskmanager interacts with native Windows APIs (process management, services, startup entries, and optional Administrator elevation), security reports are taken seriously.

**Please do not report security vulnerabilities via public GitHub issues.**

Instead, please use **GitHub Private Vulnerability Reporting**:
1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Provide a clear description, affected version, reproduction steps, and (if possible) a suggested fix.

You can expect an initial response within a few days. Once confirmed, a fix and advisory will be coordinated before public disclosure.

## Privacy & Local-Only Design

- **No telemetry or tracking:** Spektr Taskmanager does not collect analytics, crash reports, or usage data and does not phone home.
- **No kernel drivers:** All metrics are queried through standard documented and native Windows user-mode APIs (Win32, PDH, DXGI, NVML, WMI, ETW, Restart Manager) without bundling third-party kernel drivers.
- **Optional external lookups:** Clicking a VirusTotal link in the Process Inspector explicitly opens your browser with the locally computed SHA-256 hash — no files are ever uploaded automatically.
