import path from "node:path";
import { Worker } from "node:worker_threads";
import cron from "node-cron";
import type { LoggerWithArchiverOptions, RequiredLoggerOptions, RetentionUnit } from "./types";
import { parseRetention } from "./utilities";

/**
 * Get the internal cron schedule based on retention unit.
 * These are not user-configurable.
 */
export function getRetentionCron(unit: RetentionUnit): string {
  switch (unit) {
    case "h":
      return "0 * * * *"; // Top of every hour
    case "d":
      return "0 1 * * *"; // 1 AM daily
    case "w":
      return "0 1 * * 1"; // 1 AM Monday
    case "m":
      return "0 1 1 * *"; // 1 AM, 1st of month
    case "y":
      return "0 1 1 1 *"; // 1 AM, Jan 1st
  }
}

/** Run the retention worker */
export function runRetentionWorker(options: RequiredLoggerOptions) {
  const workerPath = path.resolve(__dirname, "run-retention-worker.js");
  new Worker(workerPath, { workerData: options });
}

/**
 * Start the retention scheduler.
 * @returns A function to stop the retention scheduler
 */
export function startRetention(options: LoggerWithArchiverOptions) {
  const { logRetention } = options;

  // If no retention configured, return a no-op stop function
  if (!logRetention) {
    return () => { };
  }

  // Run retention check on creation
  const { logger: _logger, ...workerData } = options;
  runRetentionWorker(workerData);

  return scheduleNextRun(options);
}

/**
 * Schedule the next retention run.
 * Runs based on the retention unit.
 * @returns A function to stop the retention scheduler
 */
function scheduleNextRun(options: LoggerWithArchiverOptions) {
  const { logger, logRetention, ...workerData } = options;

  if (!logRetention) {
    return () => { };
  }

  const { unit } = parseRetention(logRetention);
  const retentionCron = getRetentionCron(unit);

  logger.info(
    `Scheduling retention check with retention: ${logRetention} (cron: ${retentionCron})`,
  );

  const task = cron.schedule(retentionCron, () => {
    runRetentionWorker({ ...workerData, logRetention });
  });

  return () => {
    logger.info("Cleared retention check interval");
    task.stop();
  };
}
