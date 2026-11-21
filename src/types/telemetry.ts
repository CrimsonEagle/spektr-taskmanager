export interface CpuMetrics {
  totalUsage: number;
  perCore: number[];
  perCoreFrequencyMhz?: number[];
  brand: string;
  frequencyMhz: number;
  baseFrequencyMhz?: number;
  physicalCores: number;
  logicalCores: number;
  temperatureC: number | null;
  powerWatts?: number | null;
  sensorSource?: string | null;
}

export interface MemoryMetrics {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  cachedBytes: number;
  usagePercent: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  commitTotalBytes?: number;
  commitLimitBytes?: number;
  pagedPoolBytes?: number;
  nonPagedPoolBytes?: number;
}

export interface GpuMetrics {
  name: string;
  vendor: string;
  usagePercent: number | null;
  vramUsedBytes: number;
  vramTotalBytes: number;
  sharedUsedBytes?: number;
  sharedTotalBytes?: number;
  temperatureC: number | null;
  powerWatts: number | null;
  powerLimitWatts?: number | null;
  clockMhz?: number | null;
  memoryClockMhz?: number | null;
  fanSpeedPercent?: number | null;
  engine3dPercent?: number;
  engineCopyPercent?: number;
  engineVideoEncodePercent?: number;
  engineVideoDecodePercent?: number;
  driverVersion?: string | null;
  driverDate?: string | null;
  pciLocation?: string | null;
  available: boolean;
}

export interface DiskDriveInfo {
  name: string;
  mountPoint: string;
  fileSystem: string;
  kind: string;
  model?: string | null;
  busType?: string | null;
  isSystemDrive?: boolean;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usagePercent: number;
  activePercent?: number;
  avgResponseMs?: number;
  readBytesPerSec?: number;
  writeBytesPerSec?: number;
}

export interface DiskMetrics {
  readBytesPerSec: number;
  writeBytesPerSec: number;
  activePercent?: number;
  avgResponseMs?: number;
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
  perProcessAvailable?: boolean;
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
  profileManagedCount: number;
  profileBoostedCount: number;
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
  gpuPercent: number;
  memoryBytes: number;
  diskReadBytesPerSec: number;
  diskWriteBytesPerSec: number;
  totalDiskReadBytes: number;
  totalDiskWriteBytes: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  status: string;
  isSuspended: boolean;
  isEfficiencyMode: boolean;
  runTimeSeconds: number;
  exePath: string;
  cmdLine: string;
  handleCount: number | null;
  threadCount: number | null;
  cpuHistory: number[];
}

export interface BlameProcess {
  pid: number;
  name: string;
  subtitle: string;
  category: ProcessCategory;
  cpuPercent: number;
  gpuPercent: number;
  memoryBytes: number;
  diskBytesPerSec: number;
  netRxBytesPerSec?: number;
  netTxBytesPerSec?: number;
  netConnections: number;
  netListeningPorts: number;
}

export interface HistoryPoint {
  timestampMs: number;
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number;
  diskMbPerSec: number;
  diskActivePercent?: number;
  netKbPerSec: number;
  gpuEngine3d?: number;
  gpuEngineCopy?: number;
  gpuEngineEncode?: number;
  gpuEngineDecode?: number;
  isSpike: boolean;
  spikeReason: string | null;
  unaccountedCpuPercent: number;
  topCpu: BlameProcess[];
  topRam: BlameProcess[];
  topGpu: BlameProcess[];
  topDisk: BlameProcess[];
  topNet: BlameProcess[];
}

export interface TimeRange {
  startMs: number;
  endMs: number;
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
  startType?: string;
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
export type PerformanceMetric = "cpu" | "memory" | "gpu" | "disk" | "network";
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface ToastMessage {
  id: string;
  text: string;
  kind: "success" | "error" | "info" | "warning";
}

export interface CpuCoreInfo {
  index: number;
  coreId: number;
  efficiencyClass: number;
  isPCore: boolean;
}

export interface ProcessAffinityInfo {
  pid: number;
  processMask: number;
  systemMask: number;
  cores: CpuCoreInfo[];
  hasHybridCores: boolean;
}

export interface ProcessSecurityInfo {
  exePath: string;
  sha256: string;
  fileSize: number;
  companyName?: string | null;
  fileDescription?: string | null;
  fileVersion?: string | null;
  signed: boolean;
  signatureStatus: string;
  virustotalUrl: string;
}

export interface ProcessModuleEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface ProcessThreadEntry {
  tid: number;
  basePriority: number;
}

export interface ProcessModulesThreads {
  modules: ProcessModuleEntry[];
  threads: ProcessThreadEntry[];
  totalModules: number;
  totalThreads: number;
}

export interface ProcessEnvInfo {
  cwd?: string | null;
  envVars: [string, string][];
  truncated: boolean;
}

export interface ProcessRule {
  id: string;
  processName: string;
  enabled: boolean;
  priority?: string | null;
  ecoMode?: boolean | null;
  affinityMask?: number | null;
  alertCpuPct?: number | null;
  alertRamMb?: number | null;
}

export interface RuleAlertEvent {
  ruleId: string;
  processName: string;
  pid: number;
  message: string;
  timestamp: number;
}

export type AutostartMode = "normal" | "maximized" | "minimized";

export interface AutostartConfig {
  enabled: boolean;
  mode: AutostartMode;
}
