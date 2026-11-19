# Pulse — Moderner Windows Task Manager

Ein leichter, farbcodierter und animierter Task-Manager für Windows, gebaut mit **Tauri v2**, **Rust**, **React 19**, **TypeScript**, **Tailwind CSS v4** und **Framer Motion**.

## Highlights & Features

- **System-Design (Windows 11 Fluent / Mica-Stil):** Folgt automatisch dem Windows Hell-/Dunkel-Modus mit manuellem Umschalter (`System` / `Hell` / `Dunkel`).
- **Semantisches Farbsystem:** Klare, lebendige Farben für **CPU** (Cyan), **RAM** (Violett), **GPU** (Smaragd), **Datenträger** (Amber) und **Netzwerk** (Koralle) sowie farbcodierte Prozess-Kategorien.
- **Pulse Übersicht (Dashboard):** Live-Karten inkl. **CPU-Kern-Heatmap**, RAM-Aufteilung (Aktiv/Cache/Swap), GPU-Last/VRAM/Temperatur/Watt, Datenträger-Balken, Netzwerkdurchsatz, Akku-Status und Top-Verbraucher-Spotlight.
- **Smart Process Manager:**
  - **Gruppierte Ansicht**, **Baumansicht (Parent → Child)** und **flache Liste**
  - **Hover-Freeze:** Friert die Zeilenreihenfolge beim Hovern automatisch ein (Werte laufen weiter), damit man sich nie wieder verklickt
  - **Inline 30s Sparklines** & **Klartext-Kontext** (z. B. Skriptnamen für Node/Python, Dienste für `svchost.exe`, Browser-Tab-Rollen)
  - **Slide-In Process Inspector:** Beenden, Prozessbaum beenden, **Einfrieren/Fortsetzen (Suspend/Resume)**, **Windows 11 Eco-Modus (Efficiency Mode)**, Priorität, Speicherort öffnen, offene Handles, Kindprozesse & offene Ports
- **Performance & „Was war das gerade?“ Spike-Historie:** 15-Minuten-Ringpuffer mit automatischer Spike-Erkennung und interaktiver Timeline — klicke oder fahre über jeden Punkt im Graphen, um die damaligen Top-Prozesse zu sehen.
- **Netzwerk & Offene Ports:** Native Windows IP-Helper-Abfrage aller offenen Ports (`:3000`, `:5173`, etc.) inkl. 1-Klick-Kill.
- **System & Tools:** Autostart-Verwaltung (Registry + Autostart-Ordner), Windows-Dienste (Start/Stop/Restart) und **File Lock Finder** („Wer blockiert diese Datei?“ über die Windows Restart Manager API).
- **Command Palette (`Strg + K`):** Blitzschnelle Suche über Prozesse, Ports (`:3000`), Ansichten und Systemaktionen.
- **Mini-HUD & System-Tray:** Kompaktes, schwebendes Always-on-Top-HUD.

## Entwicklung & Start

```powershell
# Abhängigkeiten installieren
pnpm install

# Entwicklungsmodus (startet Vite + Tauri Desktop-App)
pnpm tauri dev

# Produktions-Build (.exe / Installer)
pnpm tauri build
```
