import { startArchiver } from "./archiver";
import { DEFAULT_PACKAGE_NAME } from "./config";
import { FileWriter } from "./file-writer";
import { startRetention } from "./retention";
import type {
  ArchiveFrequency,
  ArchiverOptions,
  FileWriterOptions,
  LoggerWithArchiverOptions,
  RetentionOptions,
} from "./types";
import { retentionToHours } from "./utilities";

/**
 * Registry to ensure we only have one FileWriter per log directory.
 * Key: absolute path of logDir
 */
const writerRegistry = new Map<string, FileWriter>();

/**
 * Registry to ensure we only have one Archiver per log directory.
 * Key: absolute path of logDir
 * Value: function to stop the archiver
 */
const archiverRegistry = new Map<string, { stop: () => void; options: ArchiverOptions }>();

/**
 * Registry to ensure we only have one Retention scheduler per log directory.
 * Key: absolute path of logDir
 * Value: function to stop the retention scheduler
 */
const retentionRegistry = new Map<string, { stop: () => void; options: RetentionOptions }>();

/**
 * Archive frequency priority (lower = stricter/more frequent)
 */
const ARCHIVE_FREQUENCY_PRIORITY: Record<ArchiveFrequency, number> = {
  hourly: 1,
  daily: 2,
  weekly: 3,
  monthly: 4,
};

/**
 * Compare two archive frequencies and return the stricter one.
 */
function getStricterArchiveFrequency(a: ArchiveFrequency, b: ArchiveFrequency): ArchiveFrequency {
  return ARCHIVE_FREQUENCY_PRIORITY[a] < ARCHIVE_FREQUENCY_PRIORITY[b] ? a : b;
}

/**
 * Compare two retention values and return the shorter (more restrictive) one.
 */
function getShorterRetention(a: string, b: string): string {
  const aHours = retentionToHours(a);
  const bHours = retentionToHours(b);
  return aHours < bHours ? a : b;
}

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

export type RetentionController = {
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
      // Check for archiveDir conflict (must match)
      if (existing.options.archiveDir !== opts.archiveDir) {
        throw new Error(
          `[${DEFAULT_PACKAGE_NAME}] Cannot create multiple archivers for logDir "${key}" with conflicting archiveDir. ` +
          `Existing: ${existing.options.archiveDir}, Requested: ${opts.archiveDir}`,
        );
      }

      // For archiveFrequency, stricter wins - we need to restart if new is stricter
      const newFrequency = opts.archiveFrequency;
      const existingFrequency = existing.options.archiveFrequency;

      if (
        existingFrequency &&
        newFrequency &&
        getStricterArchiveFrequency(newFrequency, existingFrequency) === newFrequency &&
        newFrequency !== existingFrequency
      ) {
        // New frequency is stricter, need to restart archiver
        existing.stop();
        const stopFn = startArchiver(opts);
        archiverRegistry.set(key, { stop: stopFn, options: opts });
      }

      isRunning = true;
      return;
    }

    const stopFn = startArchiver(opts);
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
 * Create a retention controller for the given log directory.
 * Provides start/stop methods to control the retention scheduler lifecycle.
 * @param opts - The retention options
 * @param autoStart - Whether to start the retention scheduler immediately (default: true)
 */
export function createRetentionController(
  opts: LoggerWithArchiverOptions,
  autoStart = true,
): RetentionController {
  const key = opts.logDir;
  let isRunning = false;

  const start = () => {
    if (isRunning) return;

    // If no retention configured, nothing to do
    if (!opts.logRetention) {
      return;
    }

    const existing = retentionRegistry.get(key);
    if (existing) {
      // For retention, shorter wins - we need to restart if new is shorter
      const newRetention = opts.logRetention;
      const existingRetention = existing.options.logRetention;

      if (
        existingRetention &&
        newRetention &&
        getShorterRetention(newRetention, existingRetention) === newRetention &&
        newRetention !== existingRetention
      ) {
        // New retention is shorter, need to restart retention scheduler
        existing.stop();
        const stopFn = startRetention(opts);
        retentionRegistry.set(key, { stop: stopFn, options: opts });
      }

      isRunning = true;
      return;
    }

    const stopFn = startRetention(opts);
    retentionRegistry.set(key, { stop: stopFn, options: opts });
    isRunning = true;
  };

  const stop = () => {
    if (!isRunning) return;

    const existing = retentionRegistry.get(key);
    if (existing) {
      existing.stop();
      retentionRegistry.delete(key);
    }
    isRunning = false;
  };

  if (autoStart) start();

  return { start, stop };
}

/**
 * Reset the log registry by closing all writers and stopping all archivers and retention schedulers.
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

  for (const retention of retentionRegistry.values()) {
    retention.stop();
  }
  retentionRegistry.clear();
}
