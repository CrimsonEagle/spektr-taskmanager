export interface CpuMetrics {
  totalUsage: number;
  perCore: number[];
  brand: string;
  frequencyMhz: number;
  physicalCores: number;
  logicalCores: number;
  temperatureC: number | null;
}

export interface MemoryMetrics {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  cachedBytes: number;
  usagePercent: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
}

export interface GpuMetrics {
  name: string;
  vendor: string;
  usagePercent: number | null;
  vramUsedBytes: number;
  vramTotalBytes: number;
  temperatureC: number | null;
  powerWatts: number | null;
  available: boolean;
}

export interface DiskDriveInfo {
  name: string;
  mountPoint: string;
  fileSystem: string;
  kind: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usagePercent: number;
}

export interface DiskMetrics {
  readBytesPerSec: number;
  writeBytesPerSec: number;
  drives: DiskDriveInfo[];
}

export interface NetworkInterfaceInfo {
  name: string;
  ipAddresses: string[];
  macAddress: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  totalRxBytes: number;
  totalTxBytes: number;
}

export interface NetworkMetrics {
  rxBytesPerSec: number;
  txBytesPerSec: number;
  totalRxBytes: number;
  totalTxBytes: number;
  primaryInterface: string;
  interfaces: NetworkInterfaceInfo[];
}

export interface BatteryMetrics {
  hasBattery: boolean;
  percent: number | null;
  isCharging: boolean;
  isAcPlugged: boolean;
  remainingSeconds: number | null;
}

export interface SystemSummary {
  hostname: string;
  osName: string;
  uptimeSeconds: number;
  processCount: number;
  listeningPortsCount: number;
  activeProfile: string;
}

export type ProcessCategory =
  | "app"
  | "browser"
  | "dev"
  | "game"
  | "system"
  | "background";

export interface ProcessEntry {
  pid: number;
  parentPid: number | null;
  name: string;
  groupKey: string;
  subtitle: string;
  category: ProcessCategory;
  cpuPercent: number;
  memoryBytes: number;
  diskReadBytesPerSec: number;
  diskWriteBytesPerSec: number;
  totalDiskReadBytes: number;
  totalDiskWriteBytes: number;
  status: string;
  isSuspended: boolean;
  isEfficiencyMode: boolean;
  runTimeSeconds: number;
  exePath: string;
  cmdLine: string;
  handleCount: number | null;
  cpuHistory: number[];
}

export interface BlameProcess {
  pid: number;
  name: string;
  subtitle: string;
  category: ProcessCategory;
  cpuPercent: number;
  memoryBytes: number;
}

export interface HistoryPoint {
  timestampMs: number;
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number;
  diskMbPerSec: number;
  netKbPerSec: number;
  isSpike: boolean;
  spikeReason: string | null;
  topCpu: BlameProcess[];
  topRam: BlameProcess[];
}

export interface TelemetrySnapshot {
  timestampMs: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  gpu: GpuMetrics;
  disk: DiskMetrics;
  network: NetworkMetrics;
  battery: BatteryMetrics;
  system: SystemSummary;
  processes: ProcessEntry[];
  latestPoint: HistoryPoint;
}

export interface NetworkConnectionEntry {
  protocol: string;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
  pid: number;
  processName: string;
  processSubtitle: string;
  category: ProcessCategory;
}

export interface StartupEntry {
  id: string;
  name: string;
  command: string;
  location: string;
  scope: string;
  enabled: boolean;
  registrySubkey: string;
}

export interface ServiceEntry {
  name: string;
  displayName: string;
  status: string;
  pid: number | null;
}

export interface FileLockEntry {
  pid: number;
  appName: string;
  serviceShortName: string;
  appType: string;
  processName: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export type NavTab = "overview" | "processes" | "performance" | "network" | "tools";
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ToastMessage {
  id: string;
  text: string;
  kind: "success" | "error" | "info";
}
