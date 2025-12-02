import type { RequiredLoggerOptions } from "./types";

export const DEFAULT_PACKAGE_NAME = "pino-api-logger";

/** Default logger options */
export const DEFAULT_LOGGER_OPTIONS: RequiredLoggerOptions = {
  logDir: "logs",
  level: "info",
  pinoPretty: {
    singleLine: process.env.NODE_ENV !== "development",
    colorize: true,
    ignore: "pid,hostname",
    translateTime: "yyyy-mm-dd HH:MM:ss.l",
  },
  toConsole: true,
  toFile: true,
  archiveCron: "0 1 1 * *",
  runArchiveOnCreation: true,
  archiveDir: "archives",
  archiveLogging: true,
  disableArchiving: false,
  flushInterval: 200,
  maxBufferLines: 500,
  maxBufferKilobytes: 1024,
  maxDailyLogSizeMegabytes: 100,
};
