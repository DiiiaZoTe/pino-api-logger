import cron from "node-cron";
import { DEFAULT_LOGGER_OPTIONS, DEFAULT_PACKAGE_NAME } from "./config";
import { internalCreateLogger } from "./internal-logger";
import { startMonthlyArchiver } from "./monthly-archiver";
import type { LoggerOptions, PinoLoggerWithArchiver } from "./types";

export { startMonthlyArchiver };

/**
 * Create a pinologger with a monthly archiver. Starts the monthly archiver scheduled task automatically.
 * Can be stopped by calling the `stopArchiver` method on the returned logger.
 * @param loggerOptions - The options for the logger. @see LoggerOptions for more information.
 * @returns A pino logger with a monthly archiver. @see PinoLoggerWithArchiver for more information.
 */
export function createLogger(loggerOptions: LoggerOptions = {}) {
  const options = validateLoggerOptions(loggerOptions);
  const logger = internalCreateLogger(options);
  const stopArchiver = startMonthlyArchiver({
    ...options,
    logger: logger.child({ name: "monthly-archiver" }),
  });
  (logger as PinoLoggerWithArchiver).stopArchiver = stopArchiver;
  return logger as PinoLoggerWithArchiver;
}

/** Validate the logger options and add default values if not provided */
function validateLoggerOptions(options: LoggerOptions) {
  if (options.maxBufferLines && options.maxBufferLines < 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max buffer size is less than 1, setting to 1`);
    options.maxBufferLines = 1;
  }

  if (options.maxBufferKilobytes && options.maxBufferKilobytes < 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max buffer KB size is less than 1, setting to 1KB`);
    options.maxBufferKilobytes = 1;
  }

  if (options.maxDailyLogSizeMegabytes && options.maxDailyLogSizeMegabytes <= 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max daily log size is less than 1MB, setting to 1MB`);
    options.maxDailyLogSizeMegabytes = 1;
  }

  if (options.flushInterval && options.flushInterval < 50) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Flush interval is less than 50ms, setting to 50ms`);
    options.flushInterval = 50;
  }

  if (options.archiveCron && !cron.validate(options.archiveCron)) {
    console.warn(
      `[${DEFAULT_PACKAGE_NAME}] Invalid cron expression for monthly archiver, setting to default: ${DEFAULT_LOGGER_OPTIONS.archiveCron}`,
    );
    options.archiveCron = DEFAULT_LOGGER_OPTIONS.archiveCron;
  }

  return {
    ...DEFAULT_LOGGER_OPTIONS,
    ...options,
  };
}
