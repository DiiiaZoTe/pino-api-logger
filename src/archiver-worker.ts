import fs from "node:fs/promises";
import path from "node:path";
import { workerData } from "node:worker_threads";
import { c as tar } from "tar";
import { internalCreateLogger } from "./internal-logger";
import type { ResolvedLoggerOptions } from "./types";
import { fileExists, getArchiveFilename, getCurrentPeriod, getFilePeriod } from "./utilities";

/**
 * Compress and archive log files based on the configured archive frequency
 * @param options - The options for the archiver worker
 */
export async function runArchiverWorker(options: ResolvedLoggerOptions) {
  try {
    const { logger, close } = internalCreateLogger({
      ...options,
      pinoOptions: {
        ...options.pinoOptions,
        name: "archiver-worker",
      },
    });

    const { logDir, archive } = options;

    try {
      if (archive.logging)
        logger.info(
          `Running archive worker (frequency: ${archive.frequency}) to check for log files to archive`,
        );

      const files = (await fs.readdir(logDir)).filter((f) => f.endsWith(".log"));
      if (files.length === 0) return;

      const now = new Date();
      const currentPeriod = getCurrentPeriod(now, archive.frequency);
      const filesByPeriod: Record<string, string[]> = {};

      // Group files by period, skip current (incomplete) period
      for (const file of files) {
        const period = getFilePeriod(file, archive.frequency);
        if (!period) continue; // Skip files that don't match expected format
        if (period === currentPeriod) continue; // Skip current period
        if (!filesByPeriod[period]) filesByPeriod[period] = [];
        filesByPeriod[period].push(file);
      }

      // Stop early if no files to archive
      if (Object.keys(filesByPeriod).length === 0) {
        if (archive.logging) logger.info("No files to archive");
        return;
      }

      // Create the archive directory if it doesn't exist
      const archivePath = path.join(logDir, archive.dir);
      if (!(await fileExists(archivePath))) {
        await fs.mkdir(archivePath, { recursive: true });
      }

      if (archive.logging)
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

        if (archive.logging)
          logger.info(`Archiving ${periodFiles.length} files for ${period} → ${archiveFileName}`);

        // Create tar.gz
        await tar({ gzip: true, file: archiveFullPath, cwd: logDir }, periodFiles);

        // Remove original log files
        await Promise.all(periodFiles.map((f) => fs.unlink(path.join(logDir, f))));

        if (archive.logging)
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

// Only run when actually in a worker thread (not when imported as a module)
if (workerData) {
  runArchiverWorker(workerData as ResolvedLoggerOptions);
}
