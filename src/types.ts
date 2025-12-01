import type pino from "pino";
import type { PrettyOptions } from "pino-pretty";

export type LoggerOptions = BaseLoggerOptions & FileWriterOptions & MonthlyArchiverOptions;
export type RequiredLoggerOptions = Required<LoggerOptions>;
export type LoggerWithArchiverOptions = RequiredLoggerOptions & {
  logger: pino.Logger;
};
export type PinoLoggerExtended = pino.Logger<never, boolean> & {
  stopArchiver: () => void;
  getParams: () => RequiredLoggerOptions;
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
};
