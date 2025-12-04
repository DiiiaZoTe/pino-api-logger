import { startArchiver } from "./archiver";
import { runArchiverWorker } from "./archiver-worker";
import { DEFAULT_LOGGER_OPTIONS, DEFAULT_PACKAGE_NAME } from "./config";
import { internalCreateLogger } from "./internal-logger";
import {
  cleanupLogRegistry,
  createArchiverController,
  createRetentionController,
  getOrCreateFileWriter,
} from "./registry";
import { runRetentionWorker } from "./retention-worker";
import type {
  ArchiveFrequency,
  FileRotationFrequency,
  LoggerOptions,
  PinoLoggerExtended,
  ResolvedLoggerOptions,
  RetentionFormat,
} from "./types";
import { frequencyToHours, parseRetention, retentionToHours } from "./utilities";

export { startArchiver, cleanupLogRegistry, getOrCreateFileWriter };
export type { PrettyOptions } from "pino-pretty";
export type { ArchiverController, RetentionController } from "./registry";
export type {
  ArchiveConfig,
  ConsoleConfig,
  CustomPinoOptions,
  FileConfig,
  LoggerOptions,
  PinoLoggerExtended,
  ResolvedLoggerOptions,
  RetentionConfig,
} from "./types";

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
    !options.archive.disabled,
  );

  const retention = createRetentionController(
    { ...options, logger: logger.child({ name: "retention" }) },
    !!options.retention.period,
  );

  (logger as PinoLoggerExtended).getParams = () => ({
    ...options,
    ...getParams(),
  });
  (logger as PinoLoggerExtended).stopArchiver = archiver.stop;
  (logger as PinoLoggerExtended).startArchiver = archiver.start;
  (logger as PinoLoggerExtended).stopRetention = retention.stop;
  (logger as PinoLoggerExtended).startRetention = retention.start;
  (logger as PinoLoggerExtended).runArchiver = async () => {
    await runArchiverWorker({ ...options, archive: archiver.getConfig() });
  };
  (logger as PinoLoggerExtended).runRetention = async () => {
    await runRetentionWorker({ ...options, retention: retention.getConfig() });
  };
  (logger as PinoLoggerExtended).close = async () => await close();

  return logger as PinoLoggerExtended;
}

/**
 * Validate constraint hierarchy:
 * retention.period >= archive.frequency >= file.rotationFrequency
 */
function validateConstraintHierarchy(
  fileRotationFrequency: FileRotationFrequency,
  archiveFrequency: ArchiveFrequency,
  retentionPeriod: RetentionFormat | undefined,
  archiveDisabled: boolean,
) {
  const rotationHours = frequencyToHours(fileRotationFrequency);
  const archiveHours = frequencyToHours(archiveFrequency);

  // archiveFrequency >= fileRotationFrequency
  if (!archiveDisabled && archiveHours < rotationHours) {
    throw new Error(
      `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: archiveFrequency ("${archiveFrequency}") ` +
      `must be >= fileRotationFrequency ("${fileRotationFrequency}"). ` +
      `Cannot archive incomplete rotation periods.`,
    );
  }

  if (retentionPeriod) {
    const retentionHours = retentionToHours(retentionPeriod);
    const { unit } = parseRetention(retentionPeriod);

    // logRetention >= archiveFrequency (when archiving is enabled)
    if (!archiveDisabled && retentionHours < archiveHours) {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: logRetention ("${retentionPeriod}") ` +
        `must be >= archiveFrequency ("${archiveFrequency}"). ` +
        `Cannot delete files before they can be archived.`,
      );
    }

    // logRetention >= fileRotationFrequency
    if (retentionHours < rotationHours) {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: logRetention ("${retentionPeriod}") ` +
        `must be >= fileRotationFrequency ("${fileRotationFrequency}"). ` +
        `Cannot delete files before rotation period ends.`,
      );
    }

    // Additional check: ensure retention unit makes sense with frequencies
    // e.g., can't have hourly retention with daily files
    if (unit === "h" && fileRotationFrequency === "daily") {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid configuration: logRetention with hours ("${retentionPeriod}") ` +
        `cannot be used with daily file rotation. Use "d" (days) or higher units.`,
      );
    }
  }
}

/**
 * Validate the logger options and apply defaults.
 * Returns a fully resolved options object with nested structure.
 */
function validateLoggerOptions(options: LoggerOptions): ResolvedLoggerOptions {
  // Extract nested options with defaults
  const fileOpts = options.file ?? {};
  const consoleOpts = options.console ?? {};
  const archiveOpts = options.archive ?? {};
  const retentionOpts = options.retention ?? {};

  // Validate file options
  if (fileOpts.maxBufferLines !== undefined && fileOpts.maxBufferLines < 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max buffer size is less than 1, setting to 1`);
    fileOpts.maxBufferLines = 1;
  }

  if (fileOpts.maxBufferKilobytes !== undefined && fileOpts.maxBufferKilobytes < 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max buffer KB size is less than 1, setting to 1KB`);
    fileOpts.maxBufferKilobytes = 1;
  }

  if (fileOpts.maxLogSizeMegabytes !== undefined && fileOpts.maxLogSizeMegabytes <= 1) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Max log size is less than 1MB, setting to 1MB`);
    fileOpts.maxLogSizeMegabytes = 1;
  }

  if (fileOpts.flushInterval !== undefined && fileOpts.flushInterval < 20) {
    console.warn(`[${DEFAULT_PACKAGE_NAME}] Flush interval is less than 20ms, setting to 20ms`);
    fileOpts.flushInterval = 20;
  }

  // Build resolved options with nested structure
  const resolved: ResolvedLoggerOptions = {
    logDir: options.logDir ?? DEFAULT_LOGGER_OPTIONS.logDir,
    level: options.level ?? DEFAULT_LOGGER_OPTIONS.level,
    pinoOptions: options.pinoOptions,
    file: {
      enabled: fileOpts.enabled ?? DEFAULT_LOGGER_OPTIONS.file.enabled,
      rotationFrequency:
        fileOpts.rotationFrequency ?? DEFAULT_LOGGER_OPTIONS.file.rotationFrequency,
      flushInterval: fileOpts.flushInterval ?? DEFAULT_LOGGER_OPTIONS.file.flushInterval,
      maxBufferLines: fileOpts.maxBufferLines ?? DEFAULT_LOGGER_OPTIONS.file.maxBufferLines,
      maxBufferKilobytes:
        fileOpts.maxBufferKilobytes ?? DEFAULT_LOGGER_OPTIONS.file.maxBufferKilobytes,
      maxLogSizeMegabytes:
        fileOpts.maxLogSizeMegabytes ?? DEFAULT_LOGGER_OPTIONS.file.maxLogSizeMegabytes,
    },
    console: {
      enabled: consoleOpts.enabled ?? DEFAULT_LOGGER_OPTIONS.console.enabled,
      pretty: consoleOpts.pretty ?? DEFAULT_LOGGER_OPTIONS.console.pretty,
    },
    archive: {
      frequency: archiveOpts.frequency ?? DEFAULT_LOGGER_OPTIONS.archive.frequency,
      runOnCreation: archiveOpts.runOnCreation ?? DEFAULT_LOGGER_OPTIONS.archive.runOnCreation,
      dir: archiveOpts.dir ?? DEFAULT_LOGGER_OPTIONS.archive.dir,
      logging: archiveOpts.logging ?? DEFAULT_LOGGER_OPTIONS.archive.logging,
      disabled: archiveOpts.disabled ?? DEFAULT_LOGGER_OPTIONS.archive.disabled,
    },
    retention: {
      period: retentionOpts.period ?? DEFAULT_LOGGER_OPTIONS.retention.period,
    },
  };

  //* Runtime safety checks below this point

  // Validate retention format if provided
  if (resolved.retention.period) {
    try {
      parseRetention(resolved.retention.period);
    } catch {
      throw new Error(
        `[${DEFAULT_PACKAGE_NAME}] Invalid logRetention format: "${resolved.retention.period}". ` +
        `Expected format: <number><unit> (e.g., "7d", "3m", "1y")`,
      );
    }
  }

  // Ensure at least one output is enabled (file or console)
  // This check is for JavaScript users or those bypassing TypeScript's type system
  if (resolved.file.enabled === false && resolved.console.enabled === false) {
    globalThis.console.error(
      `[${DEFAULT_PACKAGE_NAME}] Both file.enabled and console.enabled are false. At least one must be true. Setting file.enabled to true.`,
    );
    resolved.file.enabled = true;
  }

  // If not writing to file, disable archiving and retention (nothing to archive/retain)
  if (resolved.file.enabled === false) {
    resolved.archive.disabled = true;
    resolved.retention.period = undefined;
  }

  // Validate constraint hierarchy
  validateConstraintHierarchy(
    resolved.file.rotationFrequency,
    resolved.archive.frequency,
    resolved.retention.period,
    resolved.archive.disabled,
  );

  return resolved;
}
