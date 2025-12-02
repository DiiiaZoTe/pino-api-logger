import { DEFAULT_PACKAGE_NAME } from "./config";
import { FileWriter } from "./file-writer";
import { startMonthlyArchiver } from "./monthly-archiver";
import type { FileWriterOptions, LoggerWithArchiverOptions, MonthlyArchiverOptions } from "./types";

/**
 * Registry to ensure we only have one FileWriter per log directory.
 * Key: absolute path of logDir
 */
const writerRegistry = new Map<string, FileWriter>();

/**
 * Registry to ensure we only have one MonthlyArchiver per log directory.
 * Key: absolute path of logDir
 * Value: function to stop the archiver
 */
const archiverRegistry = new Map<string, { stop: () => void; options: MonthlyArchiverOptions }>();

/**
 * Get an existing FileWriter for the given log directory, or create a new one.
 * If a writer already exists, the options will be merged (taking the strictest/minimum values).
 */
export function getOrCreateFileWriter(opts: Required<FileWriterOptions>): FileWriter {
  const key = opts.logDir;
  const existing = writerRegistry.get(key);

  if (existing) {
    // Merge options: Update the existing writer with the strictest constraints
    existing.updateOptions(opts);
    return existing;
  }

  const writer = new FileWriter(opts);
  writerRegistry.set(key, writer);
  return writer;
}

export type ArchiverController = {
  start: () => void;
  stop: () => void;
};

/**
 * Create an archiver controller for the given log directory.
 * Provides start/stop methods to control the archiver lifecycle.
 * @param opts - The archiver options
 * @param autoStart - Whether to start the archiver immediately (default: true)
 */
export function createArchiverController(
  opts: LoggerWithArchiverOptions,
  autoStart = true,
): ArchiverController {
  const key = opts.logDir;
  let isRunning = false;

  const start = () => {
    if (isRunning) return;

    const existing = archiverRegistry.get(key);
    if (existing) {
      // Check for conflicts
      if (
        existing.options.archiveDir !== opts.archiveDir ||
        existing.options.archiveCron !== opts.archiveCron
      ) {
        throw new Error(
          `[${DEFAULT_PACKAGE_NAME}] Cannot create multiple archivers for logDir "${key}" with conflicting options. ` +
            `Existing: ${JSON.stringify(existing.options)}, Requested: ${JSON.stringify(opts)}`,
        );
      }
      isRunning = true;
      return;
    }

    const stopFn = startMonthlyArchiver(opts);
    archiverRegistry.set(key, { stop: stopFn, options: opts });
    isRunning = true;
  };

  const stop = () => {
    if (!isRunning) return;

    const existing = archiverRegistry.get(key);
    if (existing) {
      existing.stop();
      archiverRegistry.delete(key);
    }
    isRunning = false;
  };

  if (autoStart) start();

  return { start, stop };
}

/**
 * Reset the log registry by closing all writers and stopping all archivers.
 * Useful for testing to ensure a clean state between tests.
 */
export function resetLogRegistry() {
  for (const writer of writerRegistry.values()) {
    writer.close();
  }
  writerRegistry.clear();

  for (const archiver of archiverRegistry.values()) {
    archiver.stop();
  }
  archiverRegistry.clear();
}
