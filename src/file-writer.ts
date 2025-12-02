import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PACKAGE_NAME } from "./config";
import type { FileWriterOptions } from "./types";

type WriterState = "Idle" | "Flushing" | "Rotating" | "FlushingAndRotating";

export class FlushRotateState {
  private _state: WriterState = "Idle";

  get state() {
    return this._state;
  }

  /** Call this when a flush is requested. Returns true if caller should start flush. */
  requestFlush(): boolean {
    switch (this._state) {
      case "Idle":
        this._state = "Flushing";
        return true; // start flush immediately
      case "Rotating":
        this._state = "FlushingAndRotating";
        return true; // start flush immediately in parallel
      case "Flushing":
      case "FlushingAndRotating":
        return false; // already flushing or queued
    }
  }

  /** Call this when a rotation is requested. Returns true if caller should start rotation. */
  requestRotation(): boolean {
    switch (this._state) {
      case "Idle":
        this._state = "Rotating";
        return true;
      case "Flushing":
        this._state = "FlushingAndRotating";
        return true;
      case "Rotating":
      case "FlushingAndRotating":
        return false; // already rotating or queued
    }
  }

  /** Call this after flush completes */
  completeFlush() {
    switch (this._state) {
      case "Flushing":
        this._state = "Idle";
        break;
      case "FlushingAndRotating":
        this._state = "Rotating";
        break;
      default:
        break;
    }
  }

  /** Call this after rotation completes */
  completeRotate() {
    switch (this._state) {
      case "Rotating":
        this._state = "Idle";
        break;
      case "FlushingAndRotating":
        this._state = "Flushing";
        break;
      default:
        break;
    }
  }

  isFlushing() {
    return this._state === "Flushing" || this._state === "FlushingAndRotating";
  }

  isRotating() {
    return this._state === "Rotating" || this._state === "FlushingAndRotating";
  }
}

export class FileWriter {
  private logDir: string;
  private flushInterval: number;
  private maxBufferLines: number;
  private maxBufferKilobytes: number;
  private maxDailyLogSizeMegabytes: number;
  private maxBufferBytes: number;
  private maxDailyLogSizeBytes: number;

  private buffer: string[] = [];
  private bufferBytes = 0;

  private currentDate: string = "";
  private stream: fs.WriteStream | undefined = undefined;
  private flushTimer!: NodeJS.Timeout;
  private isEnabled: boolean = true; // true if the writer is enabled, false if it is disabled due to an error
  private initialFileSizeBytes = 0;

  private state = new FlushRotateState();

  /** Total bytes in current log file (existing + newly written) */
  private get currentFileSizeBytes(): number {
    return this.initialFileSizeBytes + (this.stream?.bytesWritten ?? 0);
  }

  constructor(opts: Required<FileWriterOptions>) {
    this.logDir = opts.logDir;
    this.flushInterval = opts.flushInterval;
    this.maxBufferLines = opts.maxBufferLines;
    this.maxBufferKilobytes = opts.maxBufferKilobytes;
    this.maxDailyLogSizeMegabytes = opts.maxDailyLogSizeMegabytes;
    this.maxBufferBytes = this.maxBufferKilobytes * 1024;
    this.maxDailyLogSizeBytes = this.maxDailyLogSizeMegabytes * 1024 * 1024;

    // Safety: fs.mkdirSync can throw
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    } catch (err) {
      console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to create log directory`, err);
      // disable logging
      this.isEnabled = false;
      return;
    }

    this.currentDate = this.getDateString();
    this.openStream(this.getInitialLogPath());

    this.flushTimer = setInterval(() => this.flushIfNeeded(), this.flushInterval);
    this.flushTimer.unref?.();
  }

  /**
   * Update options with new configuration if stricter settings are provided.
   * Used when multiple loggers share the same writer.
   */
  updateOptions(opts: Required<FileWriterOptions>) {
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
    if (opts.maxDailyLogSizeMegabytes < this.maxDailyLogSizeMegabytes) {
      this.maxDailyLogSizeMegabytes = opts.maxDailyLogSizeMegabytes;
      this.maxDailyLogSizeBytes = this.maxDailyLogSizeMegabytes * 1024 * 1024;
    }
  }

  // Helper to safely open stream and attach error handler
  private openStream(filepath: string, errorCounter: number = 0) {
    if (!this.isEnabled) return;

    // Check existing file size to account for bytes already on disk
    try {
      const stats = fs.statSync(filepath);
      this.initialFileSizeBytes = stats.size;
    } catch {
      this.initialFileSizeBytes = 0; // File doesn't exist yet
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

  private getDateString() {
    return new Date().toISOString().slice(0, 10);
  }

  private getLogPath(date: string) {
    return path.join(this.logDir, `${date}.log`);
  }

  /** Check if a file exists */
  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate candidate overflow filenames for the current date.
   * Prefer HH-mm-ss; only add millisecond (and counter) when collisions occur.
   */
  private *generateOverflowCandidates(): Generator<string> {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");

    const baseName = `${this.currentDate}~${hh}-${mm}-${ss}`;

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

  /** Get a unique overflow filename (async version) */
  private async getOverflowLogPath(): Promise<string> {
    for (const candidate of this.generateOverflowCandidates()) {
      if (!(await this.fileExists(candidate))) return candidate;
    }
    // Technically unreachable, because generator is infinite
    throw new Error(`${DEFAULT_PACKAGE_NAME}: Unable to generate unique log path`);
  }

  /** Get a unique overflow filename (sync version for constructor) */
  private getOverflowLogPathSync(): string {
    for (const candidate of this.generateOverflowCandidates()) {
      if (!fs.existsSync(candidate)) return candidate;
    }
    // Technically unreachable, because generator is infinite
    throw new Error(`${DEFAULT_PACKAGE_NAME}: Unable to generate unique log path`);
  }

  /**
   * Determine the correct log file path on startup.
   * Checks main log file first, then looks for existing overflow files with space.
   */
  private getInitialLogPath(): string {
    const mainLogPath = this.getLogPath(this.currentDate);

    // Check main log file size
    try {
      const stats = fs.statSync(mainLogPath);
      if (stats.size < this.maxDailyLogSizeBytes) {
        return mainLogPath; // Main log has space
      }
    } catch {
      return mainLogPath; // Main log doesn't exist, use it
    }

    // Main log is full, look for the most recent overflow file with space
    const overflowPattern = new RegExp(`^${this.currentDate}~\\d{2}-\\d{2}-\\d{2}.*\\.log$`);
    const overflowFiles = fs.readdirSync(this.logDir)
      .filter((f) => overflowPattern.test(f))
      .sort(); // Alphabetical sort = chronological (timestamp in name)

    if (overflowFiles.length > 0) {
      // Check the most recent overflow file (last in sorted order)
      const mostRecent = overflowFiles[overflowFiles.length - 1];
      const mostRecentPath = path.join(this.logDir, mostRecent);
      try {
        const stats = fs.statSync(mostRecentPath);
        if (stats.size < this.maxDailyLogSizeBytes) {
          return mostRecentPath; // Most recent overflow has space
        }
      } catch {
        // If we can't stat it, fall through to create new overflow
      }
    }

    // No overflow files with space, create a new one
    return this.getOverflowLogPathSync();
  }

  /** Main write interface for Pino */
  async write(msg: string) {
    if (!this.isEnabled || !this.stream) return;
    const line = msg.endsWith("\n") ? msg : `${msg}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    // Check rotation by day
    const today = this.getDateString();
    if (today !== this.currentDate) {
      this.requestRotation();
    } else if (this.currentFileSizeBytes + lineBytes >= this.maxDailyLogSizeBytes) {
      this.requestRotation();
    }

    this.buffer.push(line);
    this.bufferBytes += lineBytes;

    if (this.buffer.length >= this.maxBufferLines || this.bufferBytes >= this.maxBufferBytes) {
      this.flushIfNeeded();
    }
  }

  private flushIfNeeded() {
    if (this.buffer.length === 0) return;

    if (this.state.requestFlush()) {
      this.flushBuffer()
        .catch((err) => console.error(`[${DEFAULT_PACKAGE_NAME}] Flush failed`, err)) // Catch error
        .finally(() => this.state.completeFlush());
    }
  }

  private requestRotation() {
    if (this.state.requestRotation()) {
      this.rotateStream()
        .catch((err) => console.error(`[${DEFAULT_PACKAGE_NAME}] Rotation failed`, err)) // Catch error
        .finally(() => this.state.completeRotate());
    }
  }

  private async flushBuffer() {
    // 1. Handle disabled/broken state immediately
    if (!this.stream || !this.isEnabled) {
      this.buffer = [];
      this.bufferBytes = 0;
      return;
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

  private async rotateStream() {
    // flush current buffer before switching
    if (this.buffer.length > 0) {
      try {
        await this.flushBuffer();
      } catch (err) {
        // Swallow error to ensure we proceed with rotation (recovery)
        console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to flush buffer during rotation`, err);
      }
    }

    this.stream?.end();

    // Determine next filename
    let newPath = this.getLogPath(this.currentDate);
    if (fs.existsSync(newPath)) {
      newPath = await this.getOverflowLogPath();
    }

    this.currentDate = this.getDateString();
    // Use the helper that attaches the error listener
    this.openStream(newPath);
  }

  /** Clean shutdown */
  public async close() {
    clearInterval(this.flushTimer);
    try {
      await this.flushBuffer();
    } catch (err) {
      console.error(`[${DEFAULT_PACKAGE_NAME}] Failed to flush buffer on close`, err);
    }
    this.stream?.end();
  }

  public getInstanceOptions() {
    return {
      logDir: this.logDir,
      flushInterval: this.flushInterval,
      maxBufferLines: this.maxBufferLines,
      maxBufferKilobytes: this.maxBufferKilobytes,
      maxDailyLogSizeMegabytes: this.maxDailyLogSizeMegabytes,
      maxBufferBytes: this.maxBufferBytes,
      maxDailyLogSizeBytes: this.maxDailyLogSizeBytes,
    };
  }
}
