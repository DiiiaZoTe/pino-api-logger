import fs from "node:fs/promises";
import path from "node:path";
import { workerData } from "node:worker_threads";
import { c as tar } from "tar";
import { internalCreateLogger } from "./internal-logger";
import type { RequiredLoggerOptions } from "./types";

/** Check if a file exists */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Compress and archive the previous month's daily logs */
export async function runArchiverWorker(options: RequiredLoggerOptions) {
  try {
    const logger = internalCreateLogger(options).logger.child({ name: "monthly-archiver-worker" });

    const { logDir, archiveDir, archiveLogging } = options;

    try {
      if (archiveLogging) logger.info(`Running archive worker to check for log files to archive`);

      const files = (await fs.readdir(logDir)).filter((f) => f.endsWith(".log"));
      if (files.length === 0) return;

      const now = new Date();
      const currentMonth = now.toISOString().slice(0, 7); // YYYY-MM
      const filesByMonth: Record<string, string[]> = {};

      // Group files by month, skip current month
      for (const file of files) {
        const month = file.slice(0, 7); // assumes YYYY-MM-DD.log format
        if (month === currentMonth) continue;
        if (!filesByMonth[month]) filesByMonth[month] = [];
        filesByMonth[month].push(file);
      }

      // stop early if no files to archive
      if (Object.keys(filesByMonth).length === 0) return;

      // create the archive directory if it doesn't exist
      const archivePath = path.join(logDir, archiveDir);
      if (!(await fileExists(archivePath))) {
        await fs.mkdir(archivePath, { recursive: true });
      }

      if (archiveLogging)
        logger.info(`Found files for ${Object.keys(filesByMonth).length} month(s) to archive`);

      // Archive each month
      for (const month of Object.keys(filesByMonth)) {
        let archiveloggerName = `${month}-archive.tar.gz`;
        let archiveFullPath = path.join(archivePath, archiveloggerName);
        let counter = 1;

        // Avoid overwriting existing archive
        while (await fileExists(archiveFullPath)) {
          archiveloggerName = `${month}-archive-${counter}.tar.gz`;
          archiveFullPath = path.join(archivePath, archiveloggerName);
          counter++;
        }

        const monthFiles = filesByMonth[month];
        if (monthFiles.length === 0) continue;

        if (archiveLogging)
          logger.info(`Archiving ${monthFiles.length} files for ${month} → ${archiveloggerName}`);

        // Create tar.gz
        await tar({ gzip: true, file: archiveFullPath, cwd: logDir }, monthFiles);

        // Remove original log files
        await Promise.all(monthFiles.map((f) => fs.unlink(path.join(logDir, f))));

        if (archiveLogging)
          logger.info(`Archived ${monthFiles.length} files to ${archiveloggerName}`);
      }
    } catch (err) {
      logger.error({ err }, "Error while archiving logs");
    }
  } catch (err) {
    console.error("Error while running archiver worker", err);
  }
}

runArchiverWorker(workerData as RequiredLoggerOptions);
