import path from "node:path";
import { Worker } from "node:worker_threads";
import cron from "node-cron";
import type { ArchiveFrequency, LoggerWithArchiverOptions, RequiredLoggerOptions } from "./types";

/**
 * Get the internal cron schedule based on archive frequency.
 * These are not user-configurable.
 */
export function getArchiveCron(frequency: ArchiveFrequency): string {
  switch (frequency) {
    case "hourly":
      return "5 * * * *"; // 5 mins past every hour
    case "daily":
      return "0 1 * * *"; // 1 AM daily
    case "weekly":
      return "0 1 * * 1"; // 1 AM Monday
    case "monthly":
      return "0 1 1 * *"; // 1 AM, 1st of month
  }
}

/** Run the archiver worker */
export function runArchiverWorker(options: RequiredLoggerOptions) {
  const workerPath = path.resolve(__dirname, "run-archiver-worker.js");
  new Worker(workerPath, { workerData: options });
}

/**
 * Start the archiver
 * @returns A function to stop the archiver
 */
export function startArchiver(options: LoggerWithArchiverOptions) {
  if (options.runArchiveOnCreation) {
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
  const archiveCron = getArchiveCron(options.archiveFrequency);

  if (options.archiveLogging)
    logger.info(
      `Scheduling archive run with frequency: ${options.archiveFrequency} (cron: ${archiveCron})`,
    );

  const task = cron.schedule(archiveCron, () => {
    runArchiverWorker(workerData);
  });

  return () => {
    if (options.archiveLogging) options.logger.info(`Cleared archive run interval`);
    task.stop();
  };
}
