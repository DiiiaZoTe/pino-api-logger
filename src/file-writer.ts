import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PACKAGE_NAME } from "./config";
import type { FileRotationFrequency, ResolvedFileConfig } from "./types";

/** Options passed to FileWriter (includes logDir which is at root level) */
export type FileWriterOptions = { logDir: string } & ResolvedFileConfig;

export class FileWriter {
  private logDir: string;
  private rotationFrequency: FileRotationFrequency;
  private flushInterval: number;
  private maxBufferLines: number;
  private maxBufferKilobytes: number;
  private maxLogSizeMegabytes: number;
  private maxBufferBytes: number;
  private maxLogSizeBytes: number;

  private buffer: string[] = [];
  private bufferBytes = 0;
  private bytesWritten = 0;

  private currentPeriod: string = "";
  private currentFilePath: string = ""; // Track current file for disk size checks
  private stream: fs.WriteStream | undefined = undefined;
  private flushTimer!: NodeJS.Timeout;
  private isEnabled: boolean = true; // true if the writer is enabled, false if it is disabled due to an error
  private isClosed: boolean = false; // true if the writer has been closed
  private initialFileSizeBytes = 0;

  private isFlushing = false; // Flag to prevent concurrent flushes
  private isRotating = false; // Flag to redirect writes during rotation
  private pendingWrites: string[] = []; // Writes that arrived during rotation

  /** Total bytes in current log file (existing + newly written) */
  private get currentFileSizeBytes(): number {
    return this.initialFileSizeBytes + (this.bytesWritten ?? 0);
  }

  constructor(opts: FileWriterOptions) {
    this.logDir = opts.logDir;
    this.rotationFrequency = opts.rotationFrequency;
    this.flushInterval = opts.flushInterval;
    this.maxBufferLines = opts.maxBufferLines;
    this.maxBufferKilobytes = opts.maxBufferKilobytes;
    this.maxLogSizeMegabytes = opts.maxLogSizeMegabytes;
    this.maxBufferBytes = this.maxBufferKilobytes * 1024;
    this.maxLogSizeBytes = this.maxLogSizeMegabytes * 1024 * 1024;

    // Safety: fs.mkdirSync can throw
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    } catch (err) {
      console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to create log directory`, err);
      // disable logging
      this.isEnabled = false;
      return;
    }

    this.currentPeriod = this.getPeriodString();
    this.openStream(this.findAvailableLogPath());

    this.flushTimer = setInterval(() => this.flushIfNeeded(), this.flushInterval);
    this.flushTimer.unref?.();
  }

  /**
   * Update options with new configuration if stricter settings are provided.
   * Used when multiple loggers share the same writer.
   */
  updateOptions(opts: FileWriterOptions) {
    // Update rotation frequency: hourly wins over daily (strictest)
    if (opts.rotationFrequency === "hourly" && this.rotationFrequency === "daily") {
      this.rotationFrequency = "hourly";
      // When switching to hourly, update current period format
      this.currentPeriod = this.getPeriodString();
    }

    // Update flush interval to the minimum (fastest)
    if (opts.flushInterval < this.flushInterval) {
      this.flushInterval = opts.flushInterval;
      clearInterval(this.flushTimer);
      this.flushTimer = setInterval(() => this.flushIfNeeded(), this.flushInterval);
      this.flushTimer.unref?.();
    }

    // Update buffer limits to the minimum (safest)
    if (opts.maxBufferLines < this.maxBufferLines) {
      this.maxBufferLines = opts.maxBufferLines;
    }
    if (opts.maxBufferKilobytes < this.maxBufferKilobytes) {
      this.maxBufferKilobytes = opts.maxBufferKilobytes;
      this.maxBufferBytes = this.maxBufferKilobytes * 1024;
    }

    // Update max file size to the minimum (safest to prevent giant files)
    if (opts.maxLogSizeMegabytes < this.maxLogSizeMegabytes) {
      this.maxLogSizeMegabytes = opts.maxLogSizeMegabytes;
      this.maxLogSizeBytes = this.maxLogSizeMegabytes * 1024 * 1024;
    }
  }

  // Helper to safely open stream and attach error handler
  private openStream(filepath: string, errorCounter: number = 0) {
    if (!this.isEnabled) return;

    // Track current file path for disk size checks
    this.currentFilePath = filepath;

    // Check existing file size to account for bytes already on disk
    this.initialFileSizeBytes = this.getActualFileSizeOnDisk();

    // Reset bytes written counter for the new file
    this.bytesWritten = 0;

    this.stream = fs.createWriteStream(filepath, { flags: "a" });
    // CRITICAL: Handle stream errors to prevent process crash
    this.stream.on("error", (err) => {
      console.error(`[${DEFAULT_PACKAGE_NAME}] Write stream error`, err);
      // Optional: Try to recover or set a 'broken' state
      // try to recover by opening a new stream
      if (errorCounter < 3) {
        setTimeout(() => this.openStream(filepath, errorCounter + 1), 1000);
      } else {
        console.error(
          `[${DEFAULT_PACKAGE_NAME}] Failed to open stream after 3 attempts, disabling logging for ${filepath}`,
        );
        this.isEnabled = false;
        this.stream = undefined;
      }
    });
  }

  /**
   * Get the current period string based on rotation frequency.
   * - Daily: YYYY-MM-DD
   * - Hourly: YYYY-MM-DD~HH
   */
  private getPeriodString(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD

    if (this.rotationFrequency === "hourly") {
      const hour = String(now.getHours()).padStart(2, "0");
      return `${date}~${hour}`;
    }

    return date;
  }

  private getLogPath(period: string) {
    return path.join(this.logDir, `${period}.log`);
  }

  /**
   * Generate candidate overflow filenames for the current period.
   * Overflow files use full timestamp: YYYY-MM-DD~HH-mm-ss
   * Prefer HH-mm-ss; only add millisecond (and counter) when collisions occur.
   */
  private *generateOverflowCandidates(): Generator<string> {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");

    // Overflow always uses full timestamp format: YYYY-MM-DD~HH-mm-ss
    const baseName = `${date}~${hh}-${mm}-${ss}`;

    // First candidate: just timestamp
    yield path.join(this.logDir, `${baseName}.log`);

    // Second candidate: with milliseconds
    yield path.join(this.logDir, `${baseName}-${ms}.log`);

    // Extremely rare: append numeric suffix until unique
    let counter = 1;
    while (true) {
      yield path.join(this.logDir, `${baseName}-${ms}~${counter}.log`);
      counter++;
    }
  }

  /** Get a unique overflow filename */
  private getOverflowLogPathSync(): string {
    for (const candidate of this.generateOverflowCandidates()) {
      if (!fs.existsSync(candidate)) return candidate;
    }
    // Technically unreachable, because generator is infinite
    throw new Error(`${DEFAULT_PACKAGE_NAME}: Unable to generate unique log path`);
  }

  /**
   * Get regex pattern to match overflow files for the current period.
   * Overflow files always have format: YYYY-MM-DD~HH-mm-ss*.log
   */
  private getOverflowPattern(): RegExp {
    if (this.rotationFrequency === "hourly") {
      // For hourly, match overflow files for the current hour
      // currentPeriod is YYYY-MM-DD~HH, overflow is YYYY-MM-DD~HH-mm-ss
      const [date, hour] = this.currentPeriod.split("~");
      return new RegExp(`^${date}~${hour}-\\d{2}-\\d{2}.*\\.log$`);
    }
    // For daily, match any overflow file for the current date
    // currentPeriod is YYYY-MM-DD, overflow is YYYY-MM-DD~HH-mm-ss
    return new RegExp(`^${this.currentPeriod}~\\d{2}-\\d{2}-\\d{2}.*\\.log$`);
  }

  /**
   * Find the best log file path to write to.
   * Checks main log file first, then looks for existing overflow files with space.
   * Used on startup and during rotation to coordinate between multiple workers.
   * @param skipMainLog - If true, skip main log check (used when rotating due to size)
   * @param excludeCurrentFile - If true, exclude current file from consideration (used when rotating due to size)
   */
  private findAvailableLogPath(excludeCurrentFile = false): string {
    const mainLogPath = this.getLogPath(this.currentPeriod);

    // Check main log file size (unless we're rotating away from it due to size)
    const isCurrentFileMainLog = this.currentFilePath === mainLogPath;
    if (!(excludeCurrentFile && isCurrentFileMainLog)) {
      try {
        const stats = fs.statSync(mainLogPath);
        if (stats.size < this.maxLogSizeBytes) {
          return mainLogPath; // Main log has space
        }
      } catch {
        return mainLogPath; // Main log doesn't exist, use it
      }
    }

    // Main log is full (or excluded), look for overflow files with space
    const overflowPattern = this.getOverflowPattern();
    const overflowFiles = fs
      .readdirSync(this.logDir)
      .filter((f) => overflowPattern.test(f))
      .sort(); // Alphabetical sort = chronological (timestamp in name)

    if (overflowFiles.length > 0) {
      // Check the most recent overflow file (last in sorted order)
      const mostRecent = overflowFiles[overflowFiles.length - 1];
      const mostRecentPath = path.join(this.logDir, mostRecent);

      // Skip if this is the file we're rotating away from
      if (!(excludeCurrentFile && mostRecentPath === this.currentFilePath)) {
        try {
          const stats = fs.statSync(mostRecentPath);
          if (stats.size < this.maxLogSizeBytes) {
            return mostRecentPath; // Most recent overflow has space
          }
        } catch {
          // If we can't stat it, fall through to create new overflow
        }
      }
    }

    // No overflow files with space, create a new one
    return this.getOverflowLogPathSync();
  }

  /** Main write interface for Pino - uses flag-based buffering for rotation */
  write(msg: string): void {
    if (!this.isEnabled || !this.stream) return;

    const line = msg.endsWith("\n") ? msg : `${msg}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    // During rotation, buffer writes for the new file (near-zero overhead)
    if (this.isRotating) {
      this.pendingWrites.push(line);
      return;
    }

    // Check if rotation is needed
    const currentPeriod = this.getPeriodString();
    const wouldExceedSize = (this.currentFileSizeBytes + lineBytes) >= this.maxLogSizeBytes;
    const needsRotation = currentPeriod !== this.currentPeriod || wouldExceedSize;

    if (needsRotation) {
      // Set flag SYNCHRONOUSLY - all subsequent writes go to pending buffer
      this.isRotating = true;
      this.pendingWrites.push(line);

      // Rotate async, then process pending writes
      // Pass wouldExceedSize to skip main log check when rotating due to size
      this.rotateStream(false, wouldExceedSize)
        .then(() => this.processPendingWrites())
        .catch((err) => console.error(`[${DEFAULT_PACKAGE_NAME}] Rotation failed`, err))
        .finally(() => {
          this.isRotating = false;
        });
      return;
    }

    // Normal write path (99.9% of writes) - just buffer it
    this.bytesWritten += lineBytes;
    this.buffer.push(line);
    this.bufferBytes += lineBytes;

    if (this.buffer.length >= this.maxBufferLines || this.bufferBytes >= this.maxBufferBytes) {
      this.flushIfNeeded();
    }
  }

  /** Process writes that accumulated during rotation */
  private processPendingWrites(): void {
    if (this.pendingWrites.length === 0) return;

    // Move pending writes to the main buffer (for the new file)
    for (const line of this.pendingWrites) {
      const lineBytes = Buffer.byteLength(line, "utf8");
      this.bytesWritten += lineBytes;
      this.buffer.push(line);
      this.bufferBytes += lineBytes;
    }

    // Clear pending
    this.pendingWrites = [];

    // Trigger flush if buffer is full
    if (this.buffer.length >= this.maxBufferLines || this.bufferBytes >= this.maxBufferBytes) {
      this.flushIfNeeded();
    }
  }

  private flushIfNeeded() {
    if (this.buffer.length === 0) return;

    // Skip if already flushing (coalesce flushes)
    if (this.isFlushing) return;

    this.isFlushing = true;
    this.flushBuffer()
      .catch((err) => console.error(`[${DEFAULT_PACKAGE_NAME}] Flush failed`, err))
      .finally(() => {
        this.isFlushing = false;
      });
  }

  /** Get actual file size on disk (for multi-process safety) */
  private getActualFileSizeOnDisk(): number {
    if (!this.currentFilePath) return 0;
    try {
      return fs.statSync(this.currentFilePath).size;
    } catch {
      return 0;
    }
  }

  private async flushBuffer() {
    // 1. Handle disabled/broken state immediately
    if (!this.stream || !this.isEnabled) {
      this.buffer = [];
      this.bufferBytes = 0;
      return;
    }

    // 2. Multi-process safety: check actual disk size before flushing
    // This catches cases where other workers have written to the same file
    if (!this.isRotating) {
      const actualSize = this.getActualFileSizeOnDisk();
      if (actualSize >= this.maxLogSizeBytes) {
        // File is already at limit (other workers wrote to it)
        // Rotate WITHOUT flushing to old file - buffer goes to new file
        await this.rotateStream(true, true); // skipFlush = true, dueToSize = true
      }
    }

    const chunk = this.buffer.join("");
    this.buffer = [];
    this.bufferBytes = 0;

    await new Promise<void>((resolve, reject) => {
      // We define these here so we can clean them up properly
      const errorHandler = (err: Error) => {
        this.stream?.removeListener("drain", drainHandler);
        reject(err);
      };

      const drainHandler = () => {
        this.stream?.removeListener("error", errorHandler);
        resolve();
      };

      // 2. Write attempt
      const ok = this.stream?.write(chunk, "utf8", (err) => {
        if (err) errorHandler(err);
        else {
          // If ok was true, this callback runs on completion.
          // If ok was false, this callback runs after drain.
          // We resolve here for the "happy path" if we didn't need to wait for drain explicitly
          if (ok) resolve();
        }
      });

      // 3. Handle backpressure (buffer full)
      if (!ok) {
        this.stream?.once("drain", drainHandler);
        this.stream?.once("error", errorHandler);
      }
    });
  }

  /**
   * Rotate to a new log file.
   * @param skipFlush - Skip flushing buffer (when file is already full from other workers)
   * @param dueToSize - Rotation is due to size limit (exclude current file from consideration)
   */
  private async rotateStream(skipFlush = false, dueToSize = false) {
    // Flush current buffer before switching (unless skipFlush - when file is already full from other workers)
    if (!skipFlush && this.buffer.length > 0) {
      try {
        await this.flushBuffer();
      } catch (err) {
        // Swallow error to ensure we proceed with rotation (recovery)
        console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to flush buffer during rotation`, err);
      }
    }

    this.stream?.end();

    // Update to current period
    this.currentPeriod = this.getPeriodString();

    // Find available log path (reuses existing overflow with space, or creates new)
    // When rotating due to size, skip main log check - we know it's full
    // This coordinates between multiple workers writing to the same directory
    const newPath = this.findAvailableLogPath(dueToSize);

    // Use the helper that attaches the error listener
    this.openStream(newPath);
  }

  /** Clean shutdown */
  public async close() {
    // Prevent double-close (can happen when workers close their logger and cleanupLogRegistry runs)
    if (this.isClosed) return;
    this.isClosed = true;

    clearInterval(this.flushTimer);

    // Process any pending writes from rotation
    this.processPendingWrites();

    try {
      await this.flushBuffer();
    } catch (err) {
      console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to flush buffer on close`, err);
    }
    this.stream?.end();
  }

  /** Get current instance options (for getParams) */
  public getInstanceOptions(): ResolvedFileConfig & {
    maxBufferBytes: number;
    maxLogSizeBytes: number;
  } {
    return {
      enabled: true, // If we're here, file writing is enabled
      rotationFrequency: this.rotationFrequency,
      flushInterval: this.flushInterval,
      maxBufferLines: this.maxBufferLines,
      maxBufferKilobytes: this.maxBufferKilobytes,
      maxLogSizeMegabytes: this.maxLogSizeMegabytes,
      maxBufferBytes: this.maxBufferBytes,
      maxLogSizeBytes: this.maxLogSizeBytes,
    };
  }
}
