import path from "node:path";
import { Worker } from "node:worker_threads";
import cron from "node-cron";
import type { LoggerWithArchiverOptions, RequiredLoggerOptions } from "./types";

/** Run the archiver worker */
export function runArchiverWorker(options: RequiredLoggerOptions) {
  const workerPath = path.resolve(__dirname, "run-archiver-worker.js");
  new Worker(workerPath, { workerData: options });
}

/**
 * Start the monthly archiver
 * @returns A function to stop the monthly archiver
 */
export function startMonthlyArchiver(options: LoggerWithArchiverOptions) {
  if (options.runArchiveOnCreation) {
    const { logger: _logger, ...workerData } = options;
    runArchiverWorker(workerData);
  }
  return scheduleNextRun(options);
}

/**
 * Schedule the next archive run
 * Runs based on the provided cron schedule
 * @returns A function to stop the monthly archiver
 */
function scheduleNextRun(options: LoggerWithArchiverOptions) {
  const { logger, ...workerData } = options;
  if (options.archiveLogging)
    logger.info(`Scheduling archive run with cron: ${options.archiveCron}`);

  const task = cron.schedule(options.archiveCron, () => {
    runArchiverWorker(workerData);
  });

  return () => {
    if (options.archiveLogging) options.logger.info(`Cleared archive run interval`);
    task.stop();
  };
}
