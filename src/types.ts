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

/**
 * Type-safe output configuration that ensures at least one output (file or console) is enabled.
 * - If `toFile` is false, `toConsole` must be true or omitted (defaults to true)
 * - If `toFile` is true or omitted, `toConsole` can be any value
 */
export type OutputConfig =
  | { toFile?: true; toConsole?: boolean } // toFile true or omitted
  | { toFile: false; toConsole?: true }; // toFile false requires toConsole true

export type LoggerOptions = Omit<BaseLoggerOptions, "toFile" | "toConsole"> &
  FileWriterOptions &
  ArchiverOptions &
  RetentionOptions &
  OutputConfig;
/** pinoOptions and logRetention remain optional */
export type RequiredLoggerOptions = Required<Omit<LoggerOptions, "pinoOptions" | "logRetention">> &
  Pick<LoggerOptions, "pinoOptions" | "logRetention">;
export type LoggerWithArchiverOptions = RequiredLoggerOptions & {
  logger: pino.Logger;
};
export type PinoLoggerExtended = pino.Logger<never, boolean> & {
  stopArchiver: () => void;
  startArchiver: () => void;
  stopRetention: () => void;
  startRetention: () => void;
  getParams: () => RequiredLoggerOptions;
  close: () => Promise<void>;
};

export type BaseLoggerOptions = {
  /**
   * The directory to write the logs to from the root of process execution.
   * @default 'logs'
   */
  logDir?: string;
  /** The default log level to use
   * @default 'info'
   */
  level?: string;
  /** Whether to pretty print the console output (ignored in production)
   * @default false
   */
  pinoPretty?: PrettyOptions;
  /** Whether to write to the console
   * @default true
   */
  toConsole?: boolean;
  /**
   * Whether to write logs to a file.
   * At least one of `toFile` or `toConsole` must be true.
   * @default true
   */
  toFile?: boolean;
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
};

export type FileWriterOptions = {
  /** The directory to write the logs to from the root of process execution. */
  logDir?: string;
  /**
   * The frequency at which log files rotate.
   * - "daily": Creates files like `YYYY-MM-DD.log`
   * - "hourly": Creates files like `YYYY-MM-DD~HH.log`
   * @default "daily"
   */
  fileRotationFrequency?: FileRotationFrequency;
  /** The interval to flush the log buffer at in milliseconds.
   * @default 200 (minimum 20 -> 20ms flush interval)
   */
  flushInterval?: number;
  /** The maximum number of log lines to buffer before flushing.
   * @default 500 (minimum 1 -> 1 line buffer)
   */
  maxBufferLines?: number;
  /** The maximum number of kilobytes to buffer before flushing.
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

export type ArchiverOptions = {
  /** The directory to write the logs to from the root of process execution. */
  logDir?: string;
  /**
   * The frequency at which logs are archived.
   * - "hourly": Archives accumulated hourly log files
   * - "daily": Archives accumulated daily log files
   * - "weekly": Archives accumulated weekly log files (Monday-based weeks)
   * - "monthly": Archives accumulated monthly log files
   * @default "monthly"
   */
  archiveFrequency?: ArchiveFrequency;
  /** Whether to run the archive function immediately on logger creation.
   * @default true
   */
  runArchiveOnCreation?: boolean;
  /**
   * The directory to write the archives to from the root of process execution.
   * @default 'archives' (relative to the log directory)
   */
  archiveDir?: string;
  /** Whether to log the archive process.
   * @default true
   */
  archiveLogging?: boolean;
  /**
   * Whether to completely disable the archiving process.
   * When true, no archiver will be started and `startArchiver` must be called manually if needed.
   * @default false
   */
  disableArchiving?: boolean;
};

export type RetentionOptions = {
  /** The directory to write the logs to from the root of process execution. */
  logDir?: string;
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
  logRetention?: RetentionFormat;
};
