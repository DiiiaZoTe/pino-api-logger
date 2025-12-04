import { startArchiver } from "./archiver";
import { DEFAULT_PACKAGE_NAME } from "./config";
import { FileWriter, type FileWriterOptions } from "./file-writer";
import { startRetention } from "./retention";
import type {
  ArchiveFrequency,
  LoggerWithArchiverOptions,
  ResolvedArchiveConfig,
  ResolvedRetentionConfig,
} from "./types";
import { getShorterRetention } from "./utilities";

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
const archiverRegistry = new Map<string, { stop: () => void; options: ResolvedArchiveConfig }>();

/**
 * Registry to ensure we only have one Retention scheduler per log directory.
 * Key: absolute path of logDir
 * Value: function to stop the retention scheduler
 */
const retentionRegistry = new Map<string, { stop: () => void; options: ResolvedRetentionConfig }>();

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
 * Get an existing FileWriter for the given log directory, or create a new one.
 * If a writer already exists, the options will be merged (taking the strictest/minimum values).
 */
export function getOrCreateFileWriter(opts: FileWriterOptions): FileWriter {
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
  getConfig: () => ResolvedArchiveConfig;
};

export type RetentionController = {
  start: () => void;
  stop: () => void;
  getConfig: () => ResolvedRetentionConfig;
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
      // Check for archive.dir conflict (must match)
      if (existing.options.dir !== opts.archive.dir) {
        throw new Error(
          `[${DEFAULT_PACKAGE_NAME}] Cannot create multiple archivers for logDir "${key}" with conflicting archive.dir. ` +
          `Existing: ${existing.options.dir}, Requested: ${opts.archive.dir}`,
        );
      }

      // For archive.frequency, stricter wins - we need to restart if new is stricter
      const newFrequency = opts.archive.frequency;
      const existingFrequency = existing.options.frequency;

      if (
        existingFrequency &&
        newFrequency &&
        getStricterArchiveFrequency(newFrequency, existingFrequency) === newFrequency &&
        newFrequency !== existingFrequency
      ) {
        // New frequency is stricter, need to restart archiver
        existing.stop();
        const stopFn = startArchiver(opts);
        archiverRegistry.set(key, { stop: stopFn, options: opts.archive });
      }

      isRunning = true;
      return;
    }

    const stopFn = startArchiver(opts);
    archiverRegistry.set(key, { stop: stopFn, options: opts.archive });
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

  const getConfig = () => {
    // Get the current archive config from registry (may have been merged with stricter settings)
    const registryEntry = archiverRegistry.get(key);
    return registryEntry?.options ?? opts.archive;
  };

  if (autoStart) start();

  return { start, stop, getConfig };
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
    if (!opts.retention.period) {
      return;
    }

    const existing = retentionRegistry.get(key);
    if (existing) {
      // For retention, shorter wins - we need to restart if new is shorter
      const newRetention = opts.retention.period;
      const existingRetention = existing.options.period;

      if (
        existingRetention &&
        newRetention &&
        getShorterRetention(newRetention, existingRetention) === newRetention &&
        newRetention !== existingRetention
      ) {
        // New retention is shorter, need to restart retention scheduler
        existing.stop();
        const stopFn = startRetention(opts);
        retentionRegistry.set(key, { stop: stopFn, options: opts.retention });
      }

      isRunning = true;
      return;
    }

    const stopFn = startRetention(opts);
    retentionRegistry.set(key, { stop: stopFn, options: opts.retention });
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

  const getConfig = () => {
    // Get the current retention config from registry (may have been merged with shorter settings)
    const registryEntry = retentionRegistry.get(key);
    return registryEntry?.options ?? opts.retention;
  };

  if (autoStart) start();

  return { start, stop, getConfig };
}

/**
 * Cleanup all log registry resources by closing writers and stopping all schedulers.
 * Useful for testing to ensure a clean state between tests.
 * Note: This does NOT re-initialize - you'll need to create new loggers after calling this.
 */
export function cleanupLogRegistry() {
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
