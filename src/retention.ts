import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import cron from "node-cron";
import { DEFAULT_RETENTION_CRON } from "./config";
import { isCoordinator } from "./registry";
import type { LoggerWithArchiverOptions, ResolvedLoggerOptions, RetentionUnit } from "./types";
import { parseRetention } from "./utilities";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Get the internal cron schedule based on retention unit.
 * These are not user-configurable.
 */
export function getRetentionCron(unit: RetentionUnit): string {
  return DEFAULT_RETENTION_CRON[unit];
}

/** Run the retention worker in a separate thread. If not coordinator, skip. */
export function runRetentionWorker(options: ResolvedLoggerOptions) {
  // Check if we're coordinator before running
  if (!isCoordinator(options.logDir)) {
    return; // Skip if not coordinator
  }
  const workerPath = path.resolve(__dirname, "retention-worker.js");
  new Worker(workerPath, { workerData: options });
}

/**
 * Start the retention scheduler.
 * @returns A function to stop the retention scheduler
 */
export function startRetention(options: LoggerWithArchiverOptions) {
  const retentionPeriod = options.retention.period;

  // If no retention configured, return a no-op stop function
  if (!retentionPeriod) {
    return () => {};
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
  const { logger, ...workerData } = options;
  const retentionPeriod = options.retention.period;

  if (!retentionPeriod) {
    return () => {};
  }

  const { unit } = parseRetention(retentionPeriod);
  const retentionCron = getRetentionCron(unit);

  const isCoordinatorWorker = isCoordinator(options.logDir);

  if (isCoordinatorWorker) {
    logger.info(
      `Scheduling retention check with retention: ${retentionPeriod} (cron: ${retentionCron})`,
    );
  }

  const task = cron.schedule(retentionCron, () => {
    runRetentionWorker(workerData);
  });

  return () => {
    logger.info("Cleared retention check interval");
    task.stop();
  };
}
