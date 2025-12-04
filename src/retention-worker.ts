import fs from "node:fs/promises";
import path from "node:path";
import { workerData } from "node:worker_threads";
import { internalCreateLogger } from "./internal-logger";
import type { ResolvedLoggerOptions } from "./types";
import {
  fileExists,
  getCutoffDate,
  parseArchiveFilename,
  parseLogFilename,
  parseRetention,
} from "./utilities";

/** Delete logs and archives older than the retention period */
export async function runRetentionWorker(options: ResolvedLoggerOptions) {
  const retentionPeriod = options.retention.period;

  // If no retention configured, nothing to do
  if (!retentionPeriod) return;

  try {
    const { logger, close } = internalCreateLogger({
      ...options,
      pinoOptions: {
        ...options.pinoOptions,
        name: "retention-worker",
      },
    });

    const { logDir, archive } = options;

    try {
      const { value, unit } = parseRetention(retentionPeriod);
      const now = new Date();
      const cutoffDate = getCutoffDate(now, value, unit);

      logger.info(
        `Running retention worker (retention: ${retentionPeriod}) - deleting files older than ${cutoffDate.toISOString()}`,
      );

      let deletedLogs = 0;
      let deletedArchives = 0;

      // Process log files
      const logFiles = (await fs.readdir(logDir)).filter((f) => f.endsWith(".log"));

      for (const file of logFiles) {
        const fileDate = parseLogFilename(file);
        if (!fileDate) continue;

        if (fileDate < cutoffDate) {
          const filePath = path.join(logDir, file);
          try {
            await fs.unlink(filePath);
            deletedLogs++;
            logger.debug(`Deleted log file: ${file}`);
          } catch (err) {
            logger.error({ err }, `Failed to delete log file: ${file}`);
          }
        }
      }

      // Process archive files
      const archivePath = path.join(logDir, archive.dir);
      if (await fileExists(archivePath)) {
        const archiveFiles = (await fs.readdir(archivePath)).filter((f) => f.endsWith(".tar.gz"));

        for (const file of archiveFiles) {
          const fileDate = parseArchiveFilename(file);
          if (!fileDate) continue;

          if (fileDate < cutoffDate) {
            const filePath = path.join(archivePath, file);
            try {
              await fs.unlink(filePath);
              deletedArchives++;
              logger.debug(`Deleted archive file: ${file}`);
            } catch (err) {
              logger.error({ err }, `Failed to delete archive file: ${file}`);
            }
          }
        }
      }

      if (deletedLogs > 0 || deletedArchives > 0) {
        logger.info(
          `Retention cleanup complete: deleted ${deletedLogs} logs, ${deletedArchives} archives`,
        );
      } else {
        logger.info("Retention cleanup complete: no files to delete");
      }
    } catch (err) {
      logger.error({ err }, "Error while running retention worker");
    } finally {
      await close();
    }
  } catch (err) {
    console.error("Error while running retention worker", err);
  }
}

// Only run when actually in a worker thread (not when imported as a module)
if (workerData) {
  runRetentionWorker(workerData as ResolvedLoggerOptions);
}
