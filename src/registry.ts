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

/**
 * Get or create a MonthlyArchiver for the given log directory.
 * Enforces strict conflict resolution: throws if trying to register a different config for the same directory.
 */
export function getOrCreateArchiver(opts: LoggerWithArchiverOptions): () => void {
  const key = opts.logDir;
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
    // Return the existing stop function
    return existing.stop;
  }

  // Start new archiver
  const stop = startMonthlyArchiver(opts);
  archiverRegistry.set(key, { stop, options: opts });
  return stop;
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
