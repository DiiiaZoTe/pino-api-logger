import cluster from "node:cluster";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

/** Coordinator lock settings */
const COORDINATOR_LOCK_STALE_MS = 30000; // Consider lock stale after 30s (crashed process)
const COORDINATOR_LOCK_HEARTBEAT_MS = 10000; // Update lock mtime every 10s

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
 * Registry to track which logDirs this process is coordinator for.
 * Key: absolute path of logDir
 * Value: heartbeat interval timer
 */
const coordinatorRegistry = new Map<string, NodeJS.Timeout>();

/**
 * Get the coordinator lock path for a logDir.
 */
function getCoordinatorLockPath(logDir: string): string {
  return path.join(logDir, ".coordinator-lock");
}

/**
 * Check if a coordinator lock is stale (from a crashed process).
 */
function isCoordinatorLockStale(lockPath: string): boolean {
  try {
    const stats = fs.statSync(lockPath);
    const lockAge = Date.now() - stats.mtimeMs;
    return lockAge > COORDINATOR_LOCK_STALE_MS;
  } catch {
    return true; // Lock doesn't exist, consider it "stale" (available)
  }
}

/**
 * Update the coordinator lock mtime (heartbeat).
 */
function touchCoordinatorLock(lockPath: string): void {
  try {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  } catch {
    // Lock might have been removed, ignore
  }
}

/**
 * Try to claim coordinator role for a logDir using atomic mkdir.
 * First worker to successfully create the lock directory becomes coordinator.
 * Handles stale locks from crashed processes.
 * Returns true if this process is the coordinator.
 */
export function tryClaimCoordinator(logDir: string): boolean {
  // Primary process is always coordinator
  if (cluster.isPrimary) return true;

  // Not in cluster mode at all - this process is coordinator
  if (!cluster.isWorker) return true;

  // Already coordinator for this logDir
  if (coordinatorRegistry.has(logDir)) return true;

  const lockPath = getCoordinatorLockPath(logDir);

  // Check for stale lock from crashed process
  if (fs.existsSync(lockPath) && isCoordinatorLockStale(lockPath)) {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Another process might have claimed it, that's fine
    }
  }

  try {
    // Ensure logDir exists first
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Try atomic mkdir - only one process will succeed
    fs.mkdirSync(lockPath);

    // Write metadata for debugging (PID, hostname, timestamp)
    const metaPath = path.join(lockPath, "meta.json");
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        workerId: cluster.worker?.id,
        startedAt: new Date().toISOString(),
      }),
    );

    // We are the coordinator - start heartbeat to prevent stale lock detection
    const heartbeat = setInterval(() => {
      touchCoordinatorLock(lockPath);
    }, COORDINATOR_LOCK_HEARTBEAT_MS);
    heartbeat.unref?.(); // Don't prevent process exit

    coordinatorRegistry.set(logDir, heartbeat);
    return true;
  } catch {
    return false; // Another worker claimed coordinator role
  }
}

/**
 * Release coordinator role for a logDir.
 * Called during cleanup/shutdown.
 */
export function releaseCoordinator(logDir: string): void {
  const heartbeat = coordinatorRegistry.get(logDir);
  if (heartbeat) {
    clearInterval(heartbeat);
    coordinatorRegistry.delete(logDir);
  }

  const lockPath = getCoordinatorLockPath(logDir);
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Lock might already be gone, ignore
  }
}

/**
 * Release all coordinator locks held by this process.
 */
function releaseAllCoordinators(): void {
  for (const logDir of coordinatorRegistry.keys()) {
    releaseCoordinator(logDir);
  }
}

/**
 * Check if this process is the coordinator for a given logDir.
 */
export function isCoordinator(logDir: string): boolean {
  // Primary process is always coordinator
  if (cluster.isPrimary) return true;

  // Not in cluster mode at all - this process is coordinator
  if (!cluster.isWorker) return true;

  // Check if we claimed coordinator for this logDir
  return coordinatorRegistry.has(logDir);
}

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

  // Release all coordinator locks
  releaseAllCoordinators();
}

// Register cleanup handlers for graceful shutdown
// These ensure coordinator locks are released even on unexpected exit
let cleanupRegistered = false;
function registerCleanupHandlers(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    releaseAllCoordinators();
  };

  // Handle various exit scenarios
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[${DEFAULT_PACKAGE_NAME}] Uncaught exception, cleaning up...`, err);
    cleanup();
    process.exit(1);
  });
}

// Register cleanup handlers when module loads
registerCleanupHandlers();
