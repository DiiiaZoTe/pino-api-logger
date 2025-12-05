import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PACKAGE_NAME } from "./config";
import type { FileRotationFrequency, ResolvedFileConfig } from "./types";

/** Options passed to FileWriter (includes logDir which is at root level) */
export type FileWriterOptions = { logDir: string } & ResolvedFileConfig;

/** Rotation lock settings */
const ROTATION_LOCK_STALE_MS = 10000; // Consider lock stale after 10s (crashed process)
const ROTATION_LOCK_RETRY_MS = 20; // Retry interval when waiting for lock
const ROTATION_LOCK_MAX_RETRIES = 50; // Max retries (50 * 20ms = 1s max wait)

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
  private bytesWritten = 0; // Track bytes written to current file (for single-process rotation)

  private currentPeriod: string = "";
  private currentFilePath: string = ""; // Track current file for disk size checks
  private stream: fs.WriteStream | undefined = undefined;
  private flushTimer!: NodeJS.Timeout;
  private isEnabled: boolean = true; // true if the writer is enabled, false if it is disabled due to an error
  private isClosed: boolean = false; // true if the writer has been closed

  private isFlushing = false; // Flag to prevent concurrent flushes
  private isRotating = false; // Flag to redirect writes during rotation
  private pendingWrites: string[] = []; // Writes that arrived during rotation

  /** Path to rotation lock directory (atomic mkdir-based lock) */
  private get rotationLockPath(): string {
    return path.join(this.logDir, ".rotation-lock");
  }

  /** Estimated bytes in current file (for single-process rotation check) */
  private get currentFileSizeBytes(): number {
    return this.bytesWritten;
  }

  /**
   * Try to acquire rotation lock using atomic mkdir.
   * Returns true if lock acquired, false if another process holds it.
   * Handles stale locks from crashed processes.
   */
  private tryAcquireRotationLock(): boolean {
    try {
      // Check for stale lock (crashed process)
      try {
        const stats = fs.statSync(this.rotationLockPath);
        const lockAge = Date.now() - stats.mtimeMs;
        if (lockAge > ROTATION_LOCK_STALE_MS) {
          // Lock is stale, remove it
          fs.rmdirSync(this.rotationLockPath);
        }
      } catch {
        // Lock doesn't exist, that's fine
      }

      // Try to create lock directory (atomic operation)
      fs.mkdirSync(this.rotationLockPath);
      return true;
    } catch {
      // Lock already exists (another process is rotating)
      return false;
    }
  }

  /** Release rotation lock */
  private releaseRotationLock(): void {
    try {
      fs.rmdirSync(this.rotationLockPath);
    } catch {
      // Lock might already be released or never acquired
    }
  }

  /**
   * Wait for rotation lock with retries.
   * Returns true if lock acquired, false if timed out.
   */
  private async waitForRotationLock(): Promise<boolean> {
    for (let i = 0; i < ROTATION_LOCK_MAX_RETRIES; i++) {
      if (this.tryAcquireRotationLock()) {
        return true;
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, ROTATION_LOCK_RETRY_MS));
    }
    return false;
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

    // Initialize bytesWritten with existing file size (for rotation checks)
    try {
      const stats = fs.statSync(filepath);
      this.bytesWritten = stats.size;
    } catch {
      this.bytesWritten = 0; // File doesn't exist yet
    }

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

    // Second candidate: with milliseconds (use ~ so it sorts after base)
    yield path.join(this.logDir, `${baseName}~${ms}.log`);

    // Extremely rare: append numeric suffix until unique
    let counter = 1;
    while (true) {
      yield path.join(this.logDir, `${baseName}~${ms}~${counter}.log`);
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

    // Main log is full (or excluded), look for ANY overflow file with space
    // Check all overflow files (sorted newest first) to handle race conditions
    // when multiple workers rotate simultaneously
    const overflowPattern = this.getOverflowPattern();
    const overflowFiles = fs
      .readdirSync(this.logDir)
      .filter((f) => overflowPattern.test(f))
      .sort()
      .reverse(); // Newest first (prefer recent files)

    for (const overflowFile of overflowFiles) {
      const overflowPath = path.join(this.logDir, overflowFile);

      // Skip if this is the file we're rotating away from
      if (excludeCurrentFile && overflowPath === this.currentFilePath) {
        continue;
      }

      try {
        const stats = fs.statSync(overflowPath);
        if (stats.size < this.maxLogSizeBytes) {
          return overflowPath; // Found an overflow with space
        }
      } catch {
        // If we can't stat it, try next file
      }
    }

    // No overflow files with space, create a new one
    return this.getOverflowLogPathSync();
  }

  /**
   * Main write interface for Pino.
   * Size-based rotation is checked at flush time (not per-write) to allow
   * multiple workers to converge on the same overflow file under high load.
   */
  write(msg: string): void {
    if (!this.isEnabled || !this.stream) return;

    const line = msg.endsWith("\n") ? msg : `${msg}\n`;

    // During rotation, buffer writes for the new file (near-zero overhead)
    if (this.isRotating) {
      this.pendingWrites.push(line);
      return;
    }

    const lineBytes = Buffer.byteLength(line, "utf8");

    // Check if rotation is needed (period change OR size limit)
    const currentPeriod = this.getPeriodString();
    const wouldExceedSize = this.currentFileSizeBytes + lineBytes >= this.maxLogSizeBytes;
    const needsRotation = currentPeriod !== this.currentPeriod || wouldExceedSize;

    if (needsRotation) {
      // Set flag SYNCHRONOUSLY - all subsequent writes go to pending buffer
      this.isRotating = true;
      this.pendingWrites.push(line);

      // Rotate: pass wouldExceedSize to exclude current file when rotating due to size
      this.rotateStream(false, wouldExceedSize)
        .then(() => this.processPendingWrites())
        .catch((err) => console.error(`[${DEFAULT_PACKAGE_NAME}] Rotation failed`, err))
        .finally(() => {
          this.isRotating = false;
        });
      return;
    }

    // Normal write path - buffer it and track bytes
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
   * Rotate to a new log file with cross-process coordination.
   * Uses mkdir-based locking to ensure only one worker creates the new overflow file.
   * @param skipFlush - Skip flushing buffer (when file is already full from other workers)
   * @param dueToSize - Rotation is due to size limit (exclude current file from consideration)
   */
  private async rotateStream(skipFlush = false, dueToSize = false) {
    // Try to acquire rotation lock
    const gotLock = await this.waitForRotationLock();

    if (gotLock) {
      // We hold the lock - perform the actual rotation
      try {
        // Flush current buffer before switching (unless skipFlush)
        if (!skipFlush && this.buffer.length > 0) {
          try {
            await this.flushBuffer();
          } catch (err) {
            console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to flush buffer during rotation`, err);
          }
        }

        this.stream?.end();
        this.currentPeriod = this.getPeriodString();

        // Find/create new log file
        const newPath = this.findAvailableLogPath(dueToSize);
        this.openStream(newPath);
      } finally {
        // Always release lock
        this.releaseRotationLock();
      }
    } else {
      // Another worker is rotating - just switch to whatever file they created
      // Flush to current file first (it might still have space)
      if (!skipFlush && this.buffer.length > 0) {
        try {
          await this.flushBuffer();
        } catch {
          // Ignore - file might be full
        }
      }

      this.stream?.end();
      this.currentPeriod = this.getPeriodString();

      // Find the file the other worker created (or one with space)
      const newPath = this.findAvailableLogPath(dueToSize);
      this.openStream(newPath);
    }
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
