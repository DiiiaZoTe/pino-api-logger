import type pino from "pino";
import type { PrettyOptions } from "pino-pretty";

/** Pino options that can be customized by the user (transport is managed internally) */
export type CustomPinoOptions = Omit<pino.LoggerOptions, "transport">;

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
  MonthlyArchiverOptions &
  OutputConfig;
/** pinoOptions remains optional as it's user-provided overrides */
export type RequiredLoggerOptions = Required<Omit<LoggerOptions, "pinoOptions">> &
  Pick<LoggerOptions, "pinoOptions">;
export type LoggerWithArchiverOptions = RequiredLoggerOptions & {
  logger: pino.Logger;
};
export type PinoLoggerExtended = pino.Logger<never, boolean> & {
  stopArchiver: () => void;
  startArchiver: () => void;
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
  /** The maximum size of the daily log file in megabytes.
   * @default 100 (100MB)
   */
  maxDailyLogSizeMegabytes?: number;
};

export type MonthlyArchiverOptions = {
  /** The directory to write the logs to from the root of process execution. */
  logDir?: string;
  /** The cron schedule to run the archive function.
   * @default '0 1 1 * *' (At 01:00 on day-of-month 1)
   */
  archiveCron?: string;
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
