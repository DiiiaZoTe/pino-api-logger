import path from "node:path";
import { Worker } from "node:worker_threads";
import cron from "node-cron";
import { DEFAULT_ARCHIVE_CRON } from "./config";
import { isCoordinator } from "./registry";
import type { ArchiveFrequency, LoggerWithArchiverOptions, ResolvedLoggerOptions } from "./types";

/**
 * Get the internal cron schedule based on archive frequency.
 * These are not user-configurable.
 */
export function getArchiveCron(frequency: ArchiveFrequency): string {
  return DEFAULT_ARCHIVE_CRON[frequency];
}

/** Run the archiver worker in a separate thread */
export function runArchiverWorker(options: ResolvedLoggerOptions) {
  const workerPath = path.resolve(__dirname, "archiver-worker.js");
  new Worker(workerPath, { workerData: options });
}

/**
 * Start the archiver
 * @returns A function to stop the archiver
 */
export function startArchiver(options: LoggerWithArchiverOptions) {
  if (options.archive.runOnCreation) {
    const { logger: _logger, ...workerData } = options;
    runArchiverWorker(workerData);
  }
  return scheduleNextRun(options);
}

/**
 * Schedule the next archive run
 * Runs based on the archive frequency
 * @returns A function to stop the archiver
 */
function scheduleNextRun(options: LoggerWithArchiverOptions) {
  const { logger, ...workerData } = options;
  const archiveCron = getArchiveCron(options.archive.frequency);

  if (options.archive.logging)
    logger.info(
      `Scheduling archive run with frequency: ${options.archive.frequency} (cron: ${archiveCron})`,
    );

  const task = cron.schedule(archiveCron, () => {
    // Check if we're coordinator before running
    if (!isCoordinator(options.logDir)) {
      return; // Skip if not coordinator
    }
    runArchiverWorker(workerData);
  });

  return () => {
    if (options.archive.logging) options.logger.info(`Cleared archive run interval`);
    task.stop();
  };
}
