import type pino from "pino";
import type { PrettyOptions } from "pino-pretty";

/** Pino options that can be customized by the user (transport is managed internally) */
export type CustomPinoOptions = Omit<pino.LoggerOptions, "transport">;

/** File rotation frequency options */
export type FileRotationFrequency = "hourly" | "daily";

/** Archive frequency options */
export type ArchiveFrequency = "hourly" | "daily" | "weekly" | "monthly";

/** Retention unit options */
export type RetentionUnit = "h" | "d" | "w" | "m" | "y";

/** Retention format options */
export type RetentionFormat = `${number}${RetentionUnit}`;

/** Parsed retention value */
export type ParsedRetention = {
  value: number;
  unit: RetentionUnit;
};

// ============================================================================
// Configuration types (used in both public API and internally)
// ============================================================================

/**
 * File output configuration options.
 */
export type FileConfig = {
  /**
   * Whether to write logs to a file.
   * @default true
   */
  enabled?: boolean;
  /**
   * The frequency at which log files rotate.
   * - "daily": Creates files like `YYYY-MM-DD.log`
   * - "hourly": Creates files like `YYYY-MM-DD~HH.log`
   * @default "daily"
   */
  rotationFrequency?: FileRotationFrequency;
  /**
   * The interval to flush the log buffer at in milliseconds.
   * @default 200 (minimum 20 -> 20ms flush interval)
   */
  flushInterval?: number;
  /**
   * The maximum number of log lines to buffer before flushing.
   * @default 500 (minimum 1 -> 1 line buffer)
   */
  maxBufferLines?: number;
  /**
   * The maximum number of kilobytes to buffer before flushing.
   * @default 1024 (1MB)
   */
  maxBufferKilobytes?: number;
  /**
   * The maximum size of the log file per rotation period in megabytes.
   * When exceeded, an overflow file is created with timestamp suffix.
   * @default 100 (100MB)
   */
  maxLogSizeMegabytes?: number;
};

/**
 * Console output configuration options.
 */
export type ConsoleConfig = {
  /**
   * Whether to write to the console.
   * @default true
   */
  enabled?: boolean;
  /**
   * Pretty print options for console output.
   * @default { singleLine: true, colorize: true, ignore: "pid,hostname", translateTime: "yyyy-mm-dd HH:MM:ss.l" }
   */
  pretty?: PrettyOptions;
};

/**
 * Archive configuration options.
 */
export type ArchiveConfig = {
  /**
   * The frequency at which logs are archived.
   * - "hourly": Archives accumulated hourly log files
   * - "daily": Archives accumulated daily log files
   * - "weekly": Archives accumulated weekly log files (Monday-based weeks)
   * - "monthly": Archives accumulated monthly log files
   * @default "monthly"
   */
  frequency?: ArchiveFrequency;
  /**
   * Whether to run the archive function immediately on logger creation.
   * @default true
   */
  runOnCreation?: boolean;
  /**
   * The directory to write the archives to (relative to logDir).
   * @default "archives"
   */
  dir?: string;
  /**
   * Whether to log the archive process.
   * @default true
   */
  logging?: boolean;
  /**
   * Whether to completely disable the archiving process.
   * When true, no archiver will be started and `startArchiver` must be called manually if needed.
   * @default false
   */
  disabled?: boolean;
};

/**
 * Retention configuration options.
 */
export type RetentionConfig = {
  /**
   * Log retention period. Deletes both raw log files and archives older than this period.
   * Format: <number><unit> where unit is:
   * - "h" (hours): Check at top of every hour, rolling hours
   * - "d" (days): Check daily at 1 AM, rolling days
   * - "w" (weeks): Check weekly on Monday at 1 AM, rolling weeks
   * - "m" (months): Check on 1st of month at 1 AM, calendar months
   * - "y" (years): Check on Jan 1st at 1 AM, calendar years
   *
   * Examples: "12h", "7d", "2w", "3m", "1y"
   *
   * The unit determines check frequency:
   * - "90d" = rolling 90 days, checked daily
   * - "3m" = calendar-based 3 months, checked monthly
   *
   * @default undefined (no retention - logs kept indefinitely)
   */
  period?: RetentionFormat;
};

// ============================================================================
// Public-facing structured options (used by createLogger)
// ============================================================================

/**
 * Logger options for createLogger().
 * Structured configuration with grouped options for file, console, archive, and retention.
 */
export type LoggerOptions = {
  /**
   * The directory to write the logs to from the root of process execution.
   * @default "logs"
   */
  logDir?: string;
  /**
   * The default log level to use.
   * @default "info"
   */
  level?: string;
  /**
   * Custom pino options to override/extend the default configuration.
   * Transport is managed internally and cannot be overridden.
   * Options like `level`, `base`, `timestamp`, `formatters` can be customized here.
   * Note: If both `level` and `pinoOptions.level` are provided, `pinoOptions.level` takes precedence.
   * @default undefined (uses sensible defaults)
   * @example
   * ```ts
   * pinoOptions: {
   *   base: { service: 'my-api' },
   *   messageKey: 'message',
   *   customLevels: { http: 35 },
   * }
   * ```
   */
  pinoOptions?: CustomPinoOptions;
  /**
   * File output configuration.
   * @default { enabled: true, rotationFrequency: "daily", flushInterval: 200, maxBufferLines: 500, maxBufferKilobytes: 1024, maxLogSizeMegabytes: 100 }
   */
  file?: FileConfig;
  /**
   * Console output configuration.
   * @default { enabled: true, pretty: { singleLine: true, colorize: true, ... } }
   */
  console?: ConsoleConfig;
  /**
   * Archive configuration.
   * @default { frequency: "monthly", runOnCreation: true, dir: "archives", logging: true, disabled: false }
   */
  archive?: ArchiveConfig;
  /**
   * Retention configuration.
   * @default { period: undefined } (no retention - logs kept indefinitely)
   */
  retention?: RetentionConfig;
};

// ============================================================================
// Resolved options (internal use - all defaults applied)
// ============================================================================

/** File config with all defaults applied */
export type ResolvedFileConfig = {
  enabled: boolean;
  rotationFrequency: FileRotationFrequency;
  flushInterval: number;
  maxBufferLines: number;
  maxBufferKilobytes: number;
  maxLogSizeMegabytes: number;
};

/** Console config with all defaults applied */
export type ResolvedConsoleConfig = {
  enabled: boolean;
  pretty: PrettyOptions;
};

/** Archive config with all defaults applied */
export type ResolvedArchiveConfig = {
  frequency: ArchiveFrequency;
  runOnCreation: boolean;
  dir: string;
  logging: boolean;
  disabled: boolean;
};

/** Retention config (period remains optional) */
export type ResolvedRetentionConfig = {
  period?: RetentionFormat;
};

/**
 * Logger options with all defaults applied.
 * Used internally after validateLoggerOptions() processes the structured LoggerOptions.
 */
export type ResolvedLoggerOptions = {
  logDir: string;
  level: string;
  pinoOptions?: CustomPinoOptions;
  file: ResolvedFileConfig;
  console: ResolvedConsoleConfig;
  archive: ResolvedArchiveConfig;
  retention: ResolvedRetentionConfig;
};

/** Options passed to archiver/retention controllers (includes logger instance) */
export type LoggerWithArchiverOptions = ResolvedLoggerOptions & {
  logger: pino.Logger;
};

/** Extended pino logger with archiver and retention control methods */
export type PinoLoggerExtended = pino.Logger<never, boolean> & {
  /** Stop the archiver cron scheduler */
  stopArchiver: () => void;
  /** Start the archiver cron scheduler */
  startArchiver: () => void;
  /** Stop the retention cron scheduler */
  stopRetention: () => void;
  /** Start the retention cron scheduler */
  startRetention: () => void;
  /** Run archiver immediately (async, returns when complete) */
  runArchiver: () => Promise<void>;
  /** Run retention cleanup immediately (async, returns when complete) */
  runRetention: () => Promise<void>;
  /** Get the resolved logger options */
  getParams: () => ResolvedLoggerOptions;
  /** Close the logger and flush any remaining buffered logs */
  close: () => Promise<void>;
  /** Check if this logger instance is the coordinator (handles archiving/retention) */
  isCoordinator: () => boolean;
};
