import type { ArchiveFrequency, ResolvedLoggerOptions, RetentionUnit } from "./types";

export const DEFAULT_PACKAGE_NAME = "pino-api-logger";

/** Default logger options */
export const DEFAULT_LOGGER_OPTIONS: ResolvedLoggerOptions = {
  logDir: "logs",
  level: "info",
  file: {
    enabled: true,
    rotationFrequency: "daily",
    flushInterval: 200,
    maxBufferLines: 500,
    maxBufferKilobytes: 1024,
    maxLogSizeMegabytes: 100,
  },
  console: {
    enabled: true,
    pretty: {
      singleLine: process.env.NODE_ENV !== "development",
      colorize: true,
      ignore: "pid,hostname",
      translateTime: "yyyy-mm-dd HH:MM:ss.l",
    },
  },
  archive: {
    frequency: "monthly",
    runOnCreation: true,
    dir: "archives",
    logging: true,
    disabled: false,
  },
  retention: {
    period: undefined,
  },
};

/** Default retention cron schedule */
export const DEFAULT_RETENTION_CRON: Record<RetentionUnit, string> = {
  h: "5 * * * *", // 5 mins past every hour
  d: "0 1 * * *", // 1 AM daily
  w: "0 1 * * 1", // 1 AM Monday
  m: "0 1 1 * *", // 1 AM, 1st of month
  y: "0 1 1 1 *", // 1 AM, Jan 1st
};

/** Default archive cron schedule */
export const DEFAULT_ARCHIVE_CRON: Record<ArchiveFrequency, string> = {
  hourly: "5 * * * *", // 5 mins past every hour
  daily: "0 1 * * *", // 1 AM daily
  weekly: "0 1 * * 1", // 1 AM Monday
  monthly: "0 1 1 * *", // 1 AM, 1st of month
};