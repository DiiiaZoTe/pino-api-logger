import fs from "node:fs/promises";
import path from "node:path";
import { workerData } from "node:worker_threads";
import { c as tar } from "tar";
import { internalCreateLogger } from "./internal-logger";
import type { RequiredLoggerOptions } from "./types";
import { fileExists, getArchiveFilename, getCurrentPeriod, getFilePeriod } from "./utilities";

/**
 * Compress and archive log files based on the configured archive frequency
 * @param options - The options for the archiver worker
 */
export async function runArchiverWorker(options: RequiredLoggerOptions) {
  try {
    const { logger, close } = internalCreateLogger({
      ...options,
      pinoOptions: {
        ...options.pinoOptions,
        name: "archiver-worker",
      },
    });

    const { logDir, archiveDir, archiveLogging, archiveFrequency } = options;

    try {
      if (archiveLogging)
        logger.info(
          `Running archive worker (frequency: ${archiveFrequency}) to check for log files to archive`,
        );

      const files = (await fs.readdir(logDir)).filter((f) => f.endsWith(".log"));
      if (files.length === 0) return;

      const now = new Date();
      const currentPeriod = getCurrentPeriod(now, archiveFrequency);
      const filesByPeriod: Record<string, string[]> = {};

      // Group files by period, skip current (incomplete) period
      for (const file of files) {
        const period = getFilePeriod(file, archiveFrequency);
        if (!period) continue; // Skip files that don't match expected format
        if (period === currentPeriod) continue; // Skip current period
        if (!filesByPeriod[period]) filesByPeriod[period] = [];
        filesByPeriod[period].push(file);
      }

      // Stop early if no files to archive
      if (Object.keys(filesByPeriod).length === 0) {
        if (archiveLogging) logger.info("No files to archive");
        return;
      }

      // Create the archive directory if it doesn't exist
      const archivePath = path.join(logDir, archiveDir);
      if (!(await fileExists(archivePath))) {
        await fs.mkdir(archivePath, { recursive: true });
      }

      if (archiveLogging)
        logger.info(`Found files for ${Object.keys(filesByPeriod).length} period(s) to archive`);

      // Archive each period
      for (const period of Object.keys(filesByPeriod).sort()) {
        let archiveFileName = getArchiveFilename(period);
        let archiveFullPath = path.join(archivePath, archiveFileName);
        let counter = 1;

        // Avoid overwriting existing archive
        while (await fileExists(archiveFullPath)) {
          archiveFileName = `${period}-archive-${counter}.tar.gz`;
          archiveFullPath = path.join(archivePath, archiveFileName);
          counter++;
        }

        const periodFiles = filesByPeriod[period];
        if (periodFiles.length === 0) continue;

        if (archiveLogging)
          logger.info(`Archiving ${periodFiles.length} files for ${period} → ${archiveFileName}`);

        // Create tar.gz
        await tar({ gzip: true, file: archiveFullPath, cwd: logDir }, periodFiles);

        // Remove original log files
        await Promise.all(periodFiles.map((f) => fs.unlink(path.join(logDir, f))));

        if (archiveLogging)
          logger.info(`Archived ${periodFiles.length} files to ${archiveFileName}`);
      }
    } catch (err) {
      logger.error({ err }, "Error while archiving logs");
    } finally {
      // Always close the logger to flush any remaining buffered logs
      await close();
    }
  } catch (err) {
    console.error("Error while running archiver worker", err);
  }
}

runArchiverWorker(workerData as RequiredLoggerOptions);
