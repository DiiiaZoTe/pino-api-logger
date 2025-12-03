import { startArchiver } from "./archiver";
import { DEFAULT_LOGGER_OPTIONS, DEFAULT_PACKAGE_NAME } from "./config";
import { internalCreateLogger } from "./internal-logger";
import {
  createArchiverController,
  createRetentionController,
  getOrCreateFileWriter,
  resetLogRegistry,
} from "./registry";
import type {
  ArchiveFrequency,
  FileRotationFrequency,
  LoggerOptions,
  PinoLoggerExtended,
} from "./types";
import { frequencyToHours, parseRetention, retentionToHours } from "./utilities";

export { startArchiver, resetLogRegistry, getOrCreateFileWriter };
export type { PrettyOptions } from "pino-pretty";
export type { ArchiverController, RetentionController } from "./registry";
export type { CustomPinoOptions, LoggerOptions, PinoLoggerExtended } from "./types";

/**
 * Create a pino logger with archiver and retention support.
 * Starts the archiver and retention scheduled tasks automatically.
 * Can be controlled via `stopArchiver`/`startArchiver` and `stopRetention`/`startRetention` methods.
 * @param loggerOptions - The options for the logger. @see LoggerOptions for more information.
 * @returns A pino logger with archiver and retention support. @see PinoLoggerExtended for more information.
 */
export function createLogger(loggerOptions: LoggerOptions = {}) {
  const options = validateLoggerOptions(loggerOptions);
  const { logger, getParams, close } = internalCreateLogger(options);

  const archiver = createArchiverController(
    { ...options, logger: logger.child({ name: "archiver" }) },
    !options.disableArchiving,
  );

  const retention = createRetentionController(
    { ...options, logger: logger.child({ name: "retention" }) },
    !!options.logRetention,
  );

  (logger as PinoLoggerExtended).getParams = () => ({
    ...options,
    ...getParams(),
  });
  (logger as PinoLoggerExtended).stopArchiver = archiver.stop;
  (logger as PinoLoggerExtended).startArchiver = archiver.start;
  (logger as PinoLoggerExtended).stopRetention = retention.stop;
  (logger as PinoLoggerExtended).startRetention = retention.start;
  (logger as PinoLoggerExtended).close = async () => await close();
  return logger as PinoLoggerExtended;
}

/**
 * Validate constraint hierarchy:
 * logRetention >= archiveFrequency >= fileRotationFrequency
 */
function validateConstraintHierarchy(
  fileRotationFrequency: FileRotationFrequency,
  archiveFrequency: ArchiveFrequency,
  logRetention: string | undefined,
  disableArchiving: boolean,
) {
  const rotationHours = frequencyToHours(fileRotationFrequency);
  const archiveHours = frequencyToHours(archiveFrequency);

  // archiveFrequency >= fileRotationFrequency
  if (!disableArchiving && archiveHours < rotationHours) {
    throw new Error(
      `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: archiveFrequency ("${archiveFrequency}") ` +
        `must be >= fileRotationFrequency ("${fileRotationFrequency}"). ` +
        `Cannot archive incomplete rotation periods.`,
    );
  }

  if (logRetention) {
    const retentionHours = retentionToHours(logRetention);
    const { unit } = parseRetention(logRetention);

    // logRetention >= archiveFrequency (when archiving is enabled)
    if (!disableArchiving && retentionHours < archiveHours) {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: logRetention ("${logRetention}") ` +
          `must be >= archiveFrequency ("${archiveFrequency}"). ` +
          `Cannot delete files before they can be archived.`,
      );
    }

    // logRetention >= fileRotationFrequency
    if (retentionHours < rotationHours) {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: logRetention ("${logRetention}") ` +
          `must be >= fileRotationFrequency ("${fileRotationFrequency}"). ` +
          `Cannot delete files before rotation period ends.`,
      );
    }

    // Additional check: ensure retention unit makes sense with frequencies
    // e.g., can't have hourly retention with daily files
    if (unit === "h" && fileRotationFrequency === "daily") {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: logRetention with hours ("${logRetention}") ` +
          `cannot be used with daily file rotation. Use "d" (days) or higher units.`,
      );
    }
  }
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

  if (options.maxLogSizeMegabytes && options.maxLogSizeMegabytes <= 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max log size is less than 1MB, setting to 1MB`);
    options.maxLogSizeMegabytes = 1;
  }

  if (options.flushInterval && options.flushInterval < 20) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Flush interval is less than 20ms, setting to 20ms`);
    options.flushInterval = 20;
  }

  const optionsWithDefaults = {
    ...DEFAULT_LOGGER_OPTIONS,
    ...options,
  };

  //* Runtime safety checks below this point

  // Validate retention format if provided
  if (optionsWithDefaults.logRetention) {
    try {
      parseRetention(optionsWithDefaults.logRetention);
    } catch {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid logRetention format: "${optionsWithDefaults.logRetention}". ` +
        `Expected format: <number><unit> (e.g., "7d", "3m", "1y")`,
      );
    }
  }

  // Ensure at least one output is enabled (toFile or toConsole)
  // This check is for JavaScript users or those bypassing TypeScript's type system
  if (optionsWithDefaults.toFile === false && optionsWithDefaults.toConsole === false) {
    console.error(
      `[${DEFAULT_PACKAGE_NAME}] Both toFile and toConsole are false. At least one must be true. Setting toFile to true.`,
    );
    optionsWithDefaults.toFile = true;
  }

  // If not writing to file, disable archiving and retention (nothing to archive/retain)
  if (optionsWithDefaults.toFile === false) {
    optionsWithDefaults.disableArchiving = true;
    optionsWithDefaults.logRetention = undefined;
  }

  // Validate constraint hierarchy
  validateConstraintHierarchy(
    optionsWithDefaults.fileRotationFrequency,
    optionsWithDefaults.archiveFrequency,
    optionsWithDefaults.logRetention,
    optionsWithDefaults.disableArchiving,
  );

  return optionsWithDefaults;
}
