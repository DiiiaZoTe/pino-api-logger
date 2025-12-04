/** biome-ignore-all assist/source/organizeImports: who cares about imports order here */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupLogRegistry, createLogger } from "../src/index";
import {
  fileExists,
  frequencyToHours,
  getArchiveFilename,
  getCurrentPeriod,
  getCutoffDate,
  getFilePeriod,
  getMondayOfWeek,
  parseArchiveFilename,
  parseLogFilename,
  parseRetention,
  retentionToHours,
} from "../src/utilities";

const TEST_LOG_BASE_DIR = "./logs/test";
const TEST_ARCHIVE_DIR = "archives";

const todayDate = new Date().toISOString().slice(0, 10);
const currentHour = String(new Date().getHours()).padStart(2, "0");
const todayFile = `${todayDate}.log`;
const hourlyFile = `${todayDate}~${currentHour}.log`;

// Helper to get log dir for a specific test
const getTestLogDir = (testNum: string) => path.join(TEST_LOG_BASE_DIR, `test-${testNum}`);
const getTodayFilePath = (testNum: string) => path.join(getTestLogDir(testNum), todayFile);
const getHourlyFilePath = (testNum: string) => path.join(getTestLogDir(testNum), hourlyFile);

try {
  console.log("Removing test log directory if it exists...");
  await fs.rm(TEST_LOG_BASE_DIR, { recursive: true });
} catch { }

describe("Logger Package", () => {
  // Reset registry after each test to ensure isolation
  afterEach(() => {
    cleanupLogRegistry();
  });

  it("01 - should create a logger instance", () => {
    const logDir = getTestLogDir("01");
    const logger = createLogger({ logDir, archive: { runOnCreation: false } });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("02 - should write log lines to a daily file + test min flush interval", async () => {
    const logDir = getTestLogDir("02");
    const todayFilePath = getTodayFilePath("02");
    const logger = createLogger({
      logDir,
      file: { flushInterval: 10 },
      archive: { runOnCreation: false },
    });
    logger.info("Test log line");

    // wait a short moment for the buffer to flush
    await new Promise((resolve) => setTimeout(resolve, 200));

    const files = await fs.readdir(logDir);
    expect(files.length).toBeGreaterThan(0);

    const logFile = files.find((f) => f.endsWith(".log"));
    expect(logFile).toBeDefined();

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("Test log line");
  });

  it("03 - should flush immediately when buffer is full", async () => {
    const logDir = getTestLogDir("03");
    const todayFilePath = getTodayFilePath("03");
    const logger = createLogger({
      logDir,
      file: { maxBufferLines: 1 },
      archive: { runOnCreation: false },
    });
    logger.info("Line 1");
    logger.info("Line 2");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("Line 1");
    expect(content).toContain("Line 2");
  });

  it("04 - should flush when buffer is full by disk size", async () => {
    const logDir = getTestLogDir("04");
    const todayFilePath = getTodayFilePath("04");
    const logger = createLogger({
      logDir,
      file: {
        maxBufferKilobytes: 1,
        flushInterval: 300,
      },
      archive: { runOnCreation: false },
    });
    logger.info("a".repeat(750));
    logger.info("b".repeat(750));
    // should flush buffer here because the buffer is full by disk size
    // but the flush interval is 300ms, so the 200 bytes of "c" should not be in the file yet
    logger.info("c".repeat(200));

    await new Promise((resolve) => setTimeout(resolve, 50));

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("a".repeat(750));
    expect(content).toContain("b".repeat(750));
    // the 200 bytes of "c" should not be in the file yet only after the flush interval has passed
    expect(content).not.toContain("c".repeat(200));
  });

  it("05 - should work with child loggers", async () => {
    const logDir = getTestLogDir("05");
    const todayFilePath = getTodayFilePath("05");
    const logger = createLogger({
      logDir,
      file: { maxBufferLines: 1 },
      archive: { runOnCreation: false },
    });
    const child = logger.child({ request: "child-test" });
    child.info("child log line");
    child.error({ test: "child-error-test" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("child-test");
    expect(content).toContain("child log line");
    expect(content).toContain("child-error-test");
  });

  it("06 - should archive logs monthly", async () => {
    const logDir = getTestLogDir("06");
    const previousMonthDate = await createCopyOfTodayFileMinusXDays(logDir, 31);
    // create the logger instance, it should archive the previous month file
    const _logger = createLogger({
      logDir,
      archive: { dir: TEST_ARCHIVE_DIR, logging: true },
    });
    // wait for the archive to happen (1 second lets say)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const filesAfterArchive = await fs.readdir(logDir);

    // we should have 1 log file and 1 archive folder with the archive file
    expect(filesAfterArchive.length).toBe(2);
    expect(filesAfterArchive.find((f) => f.endsWith(".log"))).toBeDefined();
    // the archive folder should have the archive file
    const archiveFolder = filesAfterArchive.find((f) => f.startsWith(TEST_ARCHIVE_DIR));
    expect(archiveFolder).toBeDefined();
    const archiveFiles = await fs.readdir(path.join(logDir, TEST_ARCHIVE_DIR));
    // the archive folder should contain one archive file
    expect(archiveFiles.length).toBe(1);
    const archiveFile = archiveFiles[0];
    expect(archiveFile).toBeDefined();
    expect(archiveFile.startsWith(previousMonthDate.slice(0, 7))).toBe(true);
    expect(archiveFile.endsWith(".tar.gz")).toBe(true);
  });

  it("07 - should use internal cron schedule based on archiveFrequency", async () => {
    const logDir = getTestLogDir("07");
    // First create a log file for today so we have something to copy
    const logger1 = createLogger({ logDir, archive: { runOnCreation: false } });
    logger1.info("Initial log line");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cleanupLogRegistry();

    const previousMonthDate = await createCopyOfTodayFileMinusXDays(logDir, 62);
    // archiveFrequency: "monthly" uses internal cron "0 1 1 * *"
    const logger = createLogger({
      logDir,
      archive: {
        runOnCreation: false,
        frequency: "monthly",
        dir: TEST_ARCHIVE_DIR,
        logging: true,
      },
    });

    // Verify the logger was created with monthly frequency
    const params = logger.getParams();
    expect(params.archive.frequency).toBe("monthly");

    // Ensure archive dir exists for checking
    try {
      await fs.mkdir(path.join(logDir, TEST_ARCHIVE_DIR), { recursive: true });
    } catch { }

    // check that the archive file is not yet created (waiting for the interval to pass)
    const archiveFilesBefore = await fs.readdir(path.join(logDir, TEST_ARCHIVE_DIR));
    // we shouldn't find the archive for previousMonthDate
    expect(
      archiveFilesBefore.find((f) => f.startsWith(previousMonthDate.slice(0, 7))),
    ).toBeUndefined();
  });

  it("08 - should support custom pino options", async () => {
    const logDir = getTestLogDir("08");
    const todayFilePath = getTodayFilePath("08");
    const logger = createLogger({
      logDir,
      file: { maxBufferLines: 1 },
      archive: { runOnCreation: false },
      pinoOptions: {
        // Custom base adds service info to every log
        base: { service: "test-api", version: "1.0.0" },
        // Use 'message' instead of 'msg' as the message key
        messageKey: "message",
        // Custom level formatter (uppercase)
        formatters: {
          level: (label) => ({ severity: label.toUpperCase() }),
        },
      },
    });

    logger.info("Custom pino options test");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await fs.readFile(todayFilePath, "utf-8");
    // Find the line with our test message (not the archiver log)
    const lines = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const logLine = lines.find((l) => l.message === "Custom pino options test");

    expect(logLine).toBeDefined();
    // Check custom base properties are present
    expect(logLine.service).toBe("test-api");
    expect(logLine.version).toBe("1.0.0");
    // Check custom messageKey is used
    expect(logLine.message).toBe("Custom pino options test");
    expect(logLine.msg).toBeUndefined();
    // Check custom level formatter is applied
    expect(logLine.severity).toBe("INFO");
    expect(logLine.level).toBeUndefined();
  });

  it("09 - should merge pinoOptions formatters with defaults", async () => {
    const logDir = getTestLogDir("09");
    const todayFilePath = getTodayFilePath("09");
    // Only override level formatter, log formatter should use default (msg last)
    const logger = createLogger({
      logDir,
      file: { maxBufferLines: 1 },
      archive: { runOnCreation: false },
      pinoOptions: {
        formatters: {
          level: (label) => ({ lvl: label }),
        },
      },
    });

    logger.info({ data: "test-data" }, "Formatter merge test");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await fs.readFile(todayFilePath, "utf-8");
    // Find the line with our test message (not the archiver log)
    const lines = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const logLine = lines.find((l) => l.msg === "Formatter merge test");

    expect(logLine).toBeDefined();
    // Custom level formatter applied
    expect(logLine.lvl).toBe("info");
    // Default log formatter should still put msg last (check key order)
    const keys = Object.keys(logLine);
    expect(keys[keys.length - 1]).toBe("msg");
    expect(logLine.data).toBe("test-data");
  });

  it("10 - should not archive when disableArchiving is true", async () => {
    const logDir = getTestLogDir("10");
    const previousMonthDate = await createCopyOfTodayFileMinusXDays(logDir, 31);

    // Create logger with archiving disabled
    const _logger = createLogger({
      logDir,
      archive: {
        dir: TEST_ARCHIVE_DIR,
        disabled: true,
        runOnCreation: true, // Would normally trigger archive, but disabled
      },
    });

    // Wait for archive to potentially happen
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check that no archive folder was created
    const files = await fs.readdir(logDir);
    const archiveFolder = files.find((f) => f.startsWith(TEST_ARCHIVE_DIR));
    expect(archiveFolder).toBeUndefined();

    // The old log file should still be there (not archived)
    const oldLogFile = files.find((f) => f.startsWith(previousMonthDate));
    expect(oldLogFile).toBeDefined();
  });

  it("11 - should write to overflow file when main log is already full on startup", async () => {
    const logDir = getTestLogDir("11");
    await fs.mkdir(logDir, { recursive: true });

    // Create a main log file that exceeds 1MB (the minimum maxLogSizeMegabytes)
    const mainLogPath = path.join(logDir, todayFile);
    const largeContent = "x".repeat(1.1 * 1024 * 1024); // ~1.1MB
    await fs.writeFile(mainLogPath, largeContent);

    // Create logger with 1MB max size - should immediately use overflow
    const logger = createLogger({
      logDir,
      file: {
        maxLogSizeMegabytes: 1,
        maxBufferLines: 1,
      },
      archive: { runOnCreation: false },
    });

    logger.info("This should go to overflow file");

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check that an overflow file was created
    const files = await fs.readdir(logDir);
    const overflowFile = files.find(
      (f) => f.startsWith(todayDate) && f !== todayFile && f.endsWith(".log"),
    );
    expect(overflowFile).toBeDefined();
    if (!overflowFile) throw new Error("Overflow file not found");

    // Verify the log was written to the overflow file, not the main file
    const overflowContent = await fs.readFile(path.join(logDir, overflowFile), "utf-8");
    expect(overflowContent).toContain("This should go to overflow file");

    // Main file should still only contain the original large content (no new logs)
    const mainContent = await fs.readFile(mainLogPath, "utf-8");
    expect(mainContent).not.toContain("This should go to overflow file");
  });

  it("12 - should resume writing to existing overflow file with remaining space", async () => {
    const logDir = getTestLogDir("12");
    await fs.mkdir(logDir, { recursive: true });

    // Create a main log file that exceeds 1MB
    const mainLogPath = path.join(logDir, todayFile);
    const largeContent = "x".repeat(1.1 * 1024 * 1024); // ~1.1MB
    await fs.writeFile(mainLogPath, largeContent);

    // Create an existing overflow file with some content (but not full)
    // Use a fixed timestamp pattern that matches the overflow naming convention
    const existingOverflowName = `${todayDate}~00-00-01.log`;
    const existingOverflowPath = path.join(logDir, existingOverflowName);
    const existingContent = '{"level":30,"time":1234567890,"msg":"Previous log entry"}\n';
    await fs.writeFile(existingOverflowPath, existingContent);

    // Create logger - should pick up the existing overflow file
    const logger = createLogger({
      logDir,
      file: {
        maxLogSizeMegabytes: 1,
        maxBufferLines: 1,
      },
      archive: { runOnCreation: false },
    });

    logger.info("This should append to existing overflow");

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check the files in the directory
    const files = await fs.readdir(logDir);
    const overflowFiles = files.filter(
      (f) => f.startsWith(todayDate) && f !== todayFile && f.endsWith(".log"),
    );

    // Should only have the one existing overflow file (no new one created)
    expect(overflowFiles.length).toBe(1);
    expect(overflowFiles[0]).toBe(existingOverflowName);

    // Verify the new log was appended to the existing overflow file
    const overflowContent = await fs.readFile(existingOverflowPath, "utf-8");
    expect(overflowContent).toContain("Previous log entry"); // Original content preserved
    expect(overflowContent).toContain("This should append to existing overflow"); // New content appended
  });

  it("12b - should rotate to overflow file when writing exceeds maxLogSizeMegabytes", async () => {
    const logDir = getTestLogDir("12b");
    await fs.mkdir(logDir, { recursive: true });

    // Create logger with 1MB max size and small buffer for quick flushing
    const logger = createLogger({
      logDir,
      file: {
        maxLogSizeMegabytes: 1,
      },
      console: { enabled: false },
      archive: { runOnCreation: false },
    });

    // Write ~1.5MB of data in chunks to trigger rotation
    // Each log line is ~200 bytes with overhead, so 8000 lines ≈ 1.6MB
    const lineContent = "x".repeat(150); // ~200 bytes per line with JSON overhead
    for (let i = 0; i < 8000; i++) {
      logger.info({ line: i }, lineContent);
    }

    // Wait for all writes and rotation to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check that files were created
    const files = await fs.readdir(logDir);
    const logFiles = files.filter((f) => f.endsWith(".log"));

    // Should have at least 2 files: main log + overflow
    expect(logFiles.length).toBeGreaterThanOrEqual(2);

    // Check main log file size - should be around 1MB (not much more)
    const mainLogPath = path.join(logDir, todayFile);
    const mainStats = await fs.stat(mainLogPath);
    const mainSizeMB = mainStats.size / (1024 * 1024);

    // Main file should be close to 1MB limit (allow some buffer overshoot)
    // With the blocking rotation fix, it should not exceed by more than buffer size
    expect(mainSizeMB).toBeLessThan(1.2); // Allow 20% tolerance for buffer

    // Check that overflow file exists and has content
    const overflowFiles = logFiles.filter((f) => f !== todayFile);
    expect(overflowFiles.length).toBeGreaterThan(0);

    // Verify overflow file has content
    const overflowPath = path.join(logDir, overflowFiles[0]);
    const overflowStats = await fs.stat(overflowPath);
    expect(overflowStats.size).toBeGreaterThan(0);

    // Total size should be around 1.5-1.6MB
    const totalSize = logFiles.reduce((sum, f) => {
      const stats = require("node:fs").statSync(path.join(logDir, f));
      return sum + stats.size;
    }, 0);
    const totalSizeMB = totalSize / (1024 * 1024);
    expect(totalSizeMB).toBeGreaterThan(1.4);
    expect(totalSizeMB).toBeLessThan(2.0);
  });

  it("13 - should not write to file when file.enabled is false", async () => {
    const logDir = getTestLogDir("13");
    await fs.mkdir(logDir, { recursive: true });

    // Create logger with file.enabled: false (console only)
    const logger = createLogger({
      logDir,
      file: { enabled: false },
      // console: { enabled: true }, // Can be omitted, true is default
      archive: { runOnCreation: false },
    });

    logger.info("This should not go to file");

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check that no log file was created
    const files = await fs.readdir(logDir);
    const logFile = files.find((f) => f.endsWith(".log"));
    expect(logFile).toBeUndefined();
  });

  it("14 - should write to file when file.enabled is true and console.enabled is false", async () => {
    const logDir = getTestLogDir("14");
    const todayFilePath = getTodayFilePath("14");

    // Create logger with console.enabled: false (file only)
    const logger = createLogger({
      logDir,
      file: { enabled: true, maxBufferLines: 1 },
      console: { enabled: false },
      archive: { runOnCreation: false },
    });

    logger.info("This should go to file only");

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check that log file was created and contains the message
    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("This should go to file only");
  });

  it("15 - should disable archiving when file.enabled is false", async () => {
    const logDir = getTestLogDir("15");
    await createCopyOfTodayFileMinusXDays(logDir, 31);

    // Create logger with file.enabled: false - archiving should be automatically disabled
    const logger = createLogger({
      logDir,
      file: { enabled: false },
      console: { enabled: true },
      archive: {
        dir: TEST_ARCHIVE_DIR,
        runOnCreation: true, // Would normally trigger archive
      },
    });

    // Wait for archive to potentially happen
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check that no archive folder was created (archiving was disabled)
    const files = await fs.readdir(logDir);
    const archiveFolder = files.find((f) => f.startsWith(TEST_ARCHIVE_DIR));
    expect(archiveFolder).toBeUndefined();

    // Verify getParams shows archive.disabled is true
    const params = logger.getParams();
    expect(params.archive.disabled).toBe(true);
  });

  // New tests for v2 features
  it("16 - should write to hourly file when file.rotationFrequency is hourly", async () => {
    const logDir = getTestLogDir("16");
    const hourlyFilePath = getHourlyFilePath("16");

    const logger = createLogger({
      logDir,
      file: { rotationFrequency: "hourly", maxBufferLines: 1 },
      archive: { runOnCreation: false },
    });

    logger.info("Hourly rotation test");

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check that an hourly file was created (YYYY-MM-DD~HH.log)
    const files = await fs.readdir(logDir);
    const hourlyFileFound = files.find((f) => f === `${todayDate}~${currentHour}.log`);
    expect(hourlyFileFound).toBeDefined();

    const content = await fs.readFile(hourlyFilePath, "utf-8");
    expect(content).toContain("Hourly rotation test");
  });

  it("17 - should return correct frequency in getParams", async () => {
    const logDir = getTestLogDir("17");

    const logger = createLogger({
      logDir,
      file: { rotationFrequency: "hourly" },
      archive: { frequency: "daily", runOnCreation: false },
    });

    const params = logger.getParams();
    expect(params.file.rotationFrequency).toBe("hourly");
    expect(params.archive.frequency).toBe("daily");
  });

  it("18 - should throw error when archive.frequency < file.rotationFrequency", () => {
    const logDir = getTestLogDir("18");

    expect(() => {
      createLogger({
        logDir,
        file: { rotationFrequency: "daily" },
        archive: { frequency: "hourly", runOnCreation: false }, // Invalid: can't archive hourly when rotating daily
      });
    }).toThrow(/archiveFrequency.*must be >= fileRotationFrequency/);
  });

  it("19 - should throw error when retention.period < archive.frequency", () => {
    const logDir = getTestLogDir("19");

    expect(() => {
      createLogger({
        logDir,
        archive: { frequency: "monthly", runOnCreation: false },
        retention: { period: "1w" }, // Invalid: 1 week < 1 month
      });
    }).toThrow(/logRetention.*must be >= archiveFrequency/);
  });

  it("20 - should throw error when retention.period < file.rotationFrequency", () => {
    const logDir = getTestLogDir("20");

    expect(() => {
      createLogger({
        logDir,
        file: { rotationFrequency: "daily" },
        archive: { disabled: true, runOnCreation: false },
        retention: { period: "12h" }, // Invalid: 12 hours < 1 day
      });
    }).toThrow(/logRetention.*must be >= fileRotationFrequency/);
  });

  it("21 - should throw error when using hourly retention with daily rotation", () => {
    const logDir = getTestLogDir("21");

    expect(() => {
      createLogger({
        logDir,
        file: { rotationFrequency: "daily" },
        archive: { disabled: true, runOnCreation: false },
        retention: { period: "24h" }, // Invalid: hourly unit can't be used with daily files
      });
    }).toThrow(/logRetention with hours.*cannot be used with daily file rotation/);
  });

  it("22 - should accept valid constraint hierarchy", () => {
    const logDir = getTestLogDir("22");

    // This should not throw
    const logger = createLogger({
      logDir,
      file: { rotationFrequency: "hourly" },
      archive: { frequency: "daily", runOnCreation: false },
      retention: { period: "7d" },
    });

    const params = logger.getParams();
    expect(params.file.rotationFrequency).toBe("hourly");
    expect(params.archive.frequency).toBe("daily");
    expect(params.retention.period).toBe("7d");
  });

  it("23 - should accept retention when archiving is disabled", () => {
    const logDir = getTestLogDir("23");

    // This should not throw - retention works without archiving
    const logger = createLogger({
      logDir,
      file: { rotationFrequency: "hourly" },
      archive: { disabled: true, runOnCreation: false },
      retention: { period: "3h" },
    });

    const params = logger.getParams();
    expect(params.archive.disabled).toBe(true);
    expect(params.retention.period).toBe("3h");
  });

  it("24 - should have stopRetention and startRetention methods", () => {
    const logDir = getTestLogDir("24");

    const logger = createLogger({
      logDir,
      archive: { frequency: "daily", runOnCreation: false }, // Use daily to satisfy constraint with 7d retention
      retention: { period: "7d" },
    });

    expect(typeof logger.stopRetention).toBe("function");
    expect(typeof logger.startRetention).toBe("function");
  });

  it("25 - should throw error for invalid retention.period format", () => {
    const logDir = getTestLogDir("25");

    expect(() => {
      createLogger({
        logDir,
        //@ts-expect-error - Invalid format
        retention: { period: "invalid" }, // Invalid format
        archive: { runOnCreation: false },
      });
    }).toThrow(/Invalid logRetention format/);
  });

  it("26 - should archive files from previous day with daily frequency", async () => {
    const logDir = getTestLogDir("26");
    const archiveDir = "archives";
    await fs.mkdir(logDir, { recursive: true });

    // Create a log file for yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const yesterdayFile = `${yesterdayStr}.log`;
    await fs.writeFile(
      path.join(logDir, yesterdayFile),
      `{"level":"info","time":"${yesterday.toISOString()}","msg":"yesterday log"}\n`,
    );

    // Create a log file for today (should NOT be archived)
    await fs.writeFile(
      path.join(logDir, todayFile),
      `{"level":"info","time":"${new Date().toISOString()}","msg":"today log"}\n`,
    );

    // Create logger with daily archive frequency and run archiver
    const logger = createLogger({
      logDir,
      archive: { frequency: "daily", dir: archiveDir, logging: false, runOnCreation: false },
      console: { enabled: false },
    });
    await logger.runArchiver();

    // Check results
    const files = await fs.readdir(logDir);

    // Today's file should still exist (not archived)
    expect(files).toContain(todayFile);

    // Yesterday's file should be gone (archived)
    expect(files).not.toContain(yesterdayFile);

    // Archive folder should exist with yesterday's archive
    const archiveFiles = await fs.readdir(path.join(logDir, archiveDir));
    const expectedArchive = archiveFiles.find((f) => f.startsWith(yesterdayStr));
    expect(expectedArchive).toBeDefined();
    expect(expectedArchive).toMatch(/\.tar\.gz$/);
  });

  it("27 - should delete log files older than retention period", async () => {
    const logDir = getTestLogDir("27");
    await fs.mkdir(logDir, { recursive: true });

    // Create a log file from 10 days ago (should be deleted with 7d retention)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    const oldFile = `${oldDateStr}.log`;
    await fs.writeFile(
      path.join(logDir, oldFile),
      `{"level":"info","time":"${oldDate.toISOString()}","msg":"old log"}\n`,
    );

    // Create a log file from 3 days ago (should NOT be deleted with 7d retention)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 3);
    const recentDateStr = recentDate.toISOString().slice(0, 10);
    const recentFile = `${recentDateStr}.log`;
    await fs.writeFile(
      path.join(logDir, recentFile),
      `{"level":"info","time":"${recentDate.toISOString()}","msg":"recent log"}\n`,
    );

    // Create today's file (should NOT be deleted)
    await fs.writeFile(
      path.join(logDir, todayFile),
      `{"level":"info","time":"${new Date().toISOString()}","msg":"today log"}\n`,
    );

    // Create logger with 7d retention and run retention (archiving disabled to allow 7d retention)
    const logger = createLogger({
      logDir,
      retention: { period: "7d" },
      archive: { disabled: true },
      console: { enabled: false },
    });
    await logger.runRetention();

    // Check results
    const files = await fs.readdir(logDir);

    // Old file (10 days) should be deleted
    expect(files).not.toContain(oldFile);

    // Recent file (3 days) should still exist
    expect(files).toContain(recentFile);

    // Today's file should still exist
    expect(files).toContain(todayFile);
  });

  it("28 - should delete archive files older than retention period", async () => {
    const logDir = getTestLogDir("28");
    const archiveDir = "archives";
    const archivePath = path.join(logDir, archiveDir);
    await fs.mkdir(archivePath, { recursive: true });

    // Create a daily archive from 10 days ago (should be deleted with 7d retention)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const oldDateStr = oldDate.toISOString().slice(0, 10); // YYYY-MM-DD
    const oldArchive = `${oldDateStr}-archive.tar.gz`;
    await fs.writeFile(path.join(archivePath, oldArchive), "fake archive content");

    // Create a daily archive from 3 days ago (should NOT be deleted with 7d retention)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 3);
    const recentDateStr = recentDate.toISOString().slice(0, 10);
    const recentArchive = `${recentDateStr}-archive.tar.gz`;
    await fs.writeFile(path.join(archivePath, recentArchive), "fake recent archive content");

    // Create logger with 7d retention and run retention (archiving disabled to allow 7d retention)
    const logger = createLogger({
      logDir,
      retention: { period: "7d" },
      archive: { disabled: true },
      console: { enabled: false },
    });
    await logger.runRetention();

    // Check results
    const archiveFiles = await fs.readdir(archivePath);

    // Old archive (10 days) should be deleted
    expect(archiveFiles).not.toContain(oldArchive);

    // Recent archive (3 days) should still exist
    expect(archiveFiles).toContain(recentArchive);
  });
});

describe("Retention Utility Functions", () => {
  it("should parse retention strings correctly", () => {
    expect(parseRetention("12h")).toEqual({ value: 12, unit: "h" });
    expect(parseRetention("7d")).toEqual({ value: 7, unit: "d" });
    expect(parseRetention("2w")).toEqual({ value: 2, unit: "w" });
    expect(parseRetention("3m")).toEqual({ value: 3, unit: "m" });
    expect(parseRetention("1y")).toEqual({ value: 1, unit: "y" });
  });

  it("should throw error for invalid retention format", () => {
    //@ts-expect-error - Invalid format
    expect(() => parseRetention("invalid")).toThrow(/Invalid retention format/);
    //@ts-expect-error - Invalid format
    expect(() => parseRetention("7")).toThrow(/Invalid retention format/);
    //@ts-expect-error - Invalid format
    expect(() => parseRetention("d7")).toThrow(/Invalid retention format/);
    //@ts-expect-error - Invalid format
    expect(() => parseRetention("")).toThrow(/Invalid retention format/);
  });

  it("should convert retention to hours correctly", () => {
    expect(retentionToHours("1h")).toBe(1);
    expect(retentionToHours("24h")).toBe(24);
    expect(retentionToHours("1d")).toBe(24);
    expect(retentionToHours("7d")).toBe(168);
    expect(retentionToHours("1w")).toBe(168);
    expect(retentionToHours("1m")).toBe(744); // 31 days
    expect(retentionToHours("1y")).toBe(8784); // 366 days
  });

  it("should convert frequency to hours correctly", () => {
    expect(frequencyToHours("hourly")).toBe(1);
    expect(frequencyToHours("daily")).toBe(24);
    expect(frequencyToHours("weekly")).toBe(168);
    expect(frequencyToHours("monthly")).toBe(744);
  });
});

describe("Archive Utility Functions", () => {
  it("should get Monday of week correctly", () => {
    // Wednesday Dec 4, 2024 -> Monday Dec 2, 2024
    expect(getMondayOfWeek(new Date(2024, 11, 4))).toBe("2024-12-02");
    // Sunday Dec 8, 2024 -> Monday Dec 2, 2024
    expect(getMondayOfWeek(new Date(2024, 11, 8))).toBe("2024-12-02");
    // Monday Dec 2, 2024 -> Monday Dec 2, 2024
    expect(getMondayOfWeek(new Date(2024, 11, 2))).toBe("2024-12-02");
    // Saturday Dec 7, 2024 -> Monday Dec 2, 2024
    expect(getMondayOfWeek(new Date(2024, 11, 7))).toBe("2024-12-02");
  });

  it("should generate archive filename correctly", () => {
    expect(getArchiveFilename("2024-12")).toBe("2024-12-archive.tar.gz");
    expect(getArchiveFilename("2024-12-03")).toBe("2024-12-03-archive.tar.gz");
    expect(getArchiveFilename("2024-12-03~10")).toBe("2024-12-03~10-archive.tar.gz");
  });

  it("should extract file period for monthly frequency", () => {
    expect(getFilePeriod("2024-12-03.log", "monthly")).toBe("2024-12");
    expect(getFilePeriod("2024-12-03~10.log", "monthly")).toBe("2024-12");
    expect(getFilePeriod("2024-12-03~10-30-45.log", "monthly")).toBe("2024-12");
  });

  it("should extract file period for daily frequency", () => {
    expect(getFilePeriod("2024-12-03.log", "daily")).toBe("2024-12-03");
    expect(getFilePeriod("2024-12-03~10.log", "daily")).toBe("2024-12-03");
    expect(getFilePeriod("2024-12-03~10-30-45.log", "daily")).toBe("2024-12-03");
  });

  it("should extract file period for hourly frequency", () => {
    expect(getFilePeriod("2024-12-03~10.log", "hourly")).toBe("2024-12-03~10");
    expect(getFilePeriod("2024-12-03~10-30-45.log", "hourly")).toBe("2024-12-03~10");
    // Daily file archived hourly falls back to ~00
    expect(getFilePeriod("2024-12-03.log", "hourly")).toBe("2024-12-03~00");
  });

  it("should extract file period for weekly frequency", () => {
    // Dec 4, 2024 (Wednesday) -> Monday Dec 2, 2024
    expect(getFilePeriod("2024-12-04.log", "weekly")).toBe("2024-12-02");
    expect(getFilePeriod("2024-12-04~10.log", "weekly")).toBe("2024-12-02");
  });

  it("should return null for invalid filenames", () => {
    expect(getFilePeriod("invalid.log", "monthly")).toBeNull();
    expect(getFilePeriod("not-a-date.log", "daily")).toBeNull();
  });

  it("should get current period for each frequency", () => {
    const testDate = new Date(2024, 11, 4, 14, 30, 0); // Dec 4, 2024 14:30:00

    expect(getCurrentPeriod(testDate, "hourly")).toBe("2024-12-04~14");
    expect(getCurrentPeriod(testDate, "daily")).toBe("2024-12-04");
    expect(getCurrentPeriod(testDate, "weekly")).toBe("2024-12-02"); // Monday
    expect(getCurrentPeriod(testDate, "monthly")).toBe("2024-12");
  });
});

describe("Filename Parsing Utility Functions", () => {
  it("should parse daily log filenames", () => {
    const result = parseLogFilename("2024-12-03.log");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11); // December (0-indexed)
    expect(result?.getDate()).toBe(3);
  });

  it("should parse hourly log filenames", () => {
    const result = parseLogFilename("2024-12-03~14.log");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11);
    expect(result?.getDate()).toBe(3);
    expect(result?.getHours()).toBe(14);
  });

  it("should parse overflow log filenames", () => {
    const result = parseLogFilename("2024-12-03~14-30-45.log");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11);
    expect(result?.getDate()).toBe(3);
    expect(result?.getHours()).toBe(14);
  });

  it("should return null for invalid log filenames", () => {
    expect(parseLogFilename("invalid.log")).toBeNull();
    expect(parseLogFilename("not-a-date.log")).toBeNull();
  });

  it("should parse monthly archive filenames", () => {
    const result = parseArchiveFilename("2024-12-archive.tar.gz");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11);
    expect(result?.getDate()).toBe(1); // First day of month
  });

  it("should parse daily archive filenames", () => {
    const result = parseArchiveFilename("2024-12-03-archive.tar.gz");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11);
    expect(result?.getDate()).toBe(3);
  });

  it("should parse hourly archive filenames", () => {
    const result = parseArchiveFilename("2024-12-03~14-archive.tar.gz");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11);
    expect(result?.getDate()).toBe(3);
    expect(result?.getHours()).toBe(14);
  });

  it("should parse archive filenames with counter suffix", () => {
    const result = parseArchiveFilename("2024-12-archive-1.tar.gz");
    expect(result).not.toBeNull();
    expect(result?.getFullYear()).toBe(2024);
    expect(result?.getMonth()).toBe(11);
  });

  it("should return null for invalid archive filenames", () => {
    expect(parseArchiveFilename("invalid-archive.tar.gz")).toBeNull();
    expect(parseArchiveFilename("not-a-date.tar.gz")).toBeNull();
  });
});

describe("Cutoff Date Utility Function", () => {
  const baseDate = new Date(2024, 11, 15, 12, 0, 0); // Dec 15, 2024 12:00

  it("should calculate cutoff for hours", () => {
    const cutoff = getCutoffDate(baseDate, 6, "h");
    expect(cutoff.getHours()).toBe(6); // 12 - 6 = 6
    expect(cutoff.getDate()).toBe(15);
  });

  it("should calculate cutoff for days", () => {
    const cutoff = getCutoffDate(baseDate, 10, "d");
    expect(cutoff.getDate()).toBe(5); // 15 - 10 = 5
    expect(cutoff.getMonth()).toBe(11);
  });

  it("should calculate cutoff for weeks", () => {
    const cutoff = getCutoffDate(baseDate, 2, "w");
    expect(cutoff.getDate()).toBe(1); // 15 - 14 = 1
    expect(cutoff.getMonth()).toBe(11);
  });

  it("should calculate cutoff for months", () => {
    const cutoff = getCutoffDate(baseDate, 3, "m");
    expect(cutoff.getMonth()).toBe(8); // December(11) - 3 = September(8)
    expect(cutoff.getFullYear()).toBe(2024);
  });

  it("should calculate cutoff for years", () => {
    const cutoff = getCutoffDate(baseDate, 2, "y");
    expect(cutoff.getFullYear()).toBe(2022); // 2024 - 2 = 2022
    expect(cutoff.getMonth()).toBe(11);
  });

  it("should handle month boundary correctly", () => {
    const janDate = new Date(2024, 0, 15); // Jan 15, 2024
    const cutoff = getCutoffDate(janDate, 2, "m");
    expect(cutoff.getMonth()).toBe(10); // November 2023
    expect(cutoff.getFullYear()).toBe(2023);
  });
});

describe("File Exists Utility Function", () => {
  it("should return true for existing file", async () => {
    const logDir = getTestLogDir("util-exists");
    await fs.mkdir(logDir, { recursive: true });
    const testFile = path.join(logDir, "test.txt");
    await fs.writeFile(testFile, "test");

    expect(await fileExists(testFile)).toBe(true);
  });

  it("should return false for non-existing file", async () => {
    expect(await fileExists("/path/to/nonexistent/file.txt")).toBe(false);
  });
});

/**
 * Helper to create a copy of today's log file with a date X days ago.
 * Creates a log file for today first if it doesn't exist.
 */
const createCopyOfTodayFileMinusXDays = async (logDir: string, x = 31) => {
  // Ensure directory exists
  await fs.mkdir(logDir, { recursive: true });

  // Check if today's file exists, if not create one
  const files = await fs.readdir(logDir);
  let sourceFile = files.find((f) => f.endsWith(".log"));

  if (!sourceFile) {
    // Create a minimal log file for today
    const todayFilePath = path.join(logDir, todayFile);
    await fs.writeFile(
      todayFilePath,
      `{"level":"info","time":"${new Date().toISOString()}","msg":"test"}\n`,
    );
    sourceFile = todayFile;
  }

  const sourceDate = sourceFile.split(".")[0];
  // create a new file for the previous month (-x days)
  const previousMonthDate = new Date(
    new Date(sourceDate).setDate(new Date(sourceDate).getDate() - x),
  )
    .toISOString()
    .slice(0, 10);
  // copy the source file to the previous month date
  await fs.copyFile(path.join(logDir, sourceFile), path.join(logDir, `${previousMonthDate}.log`));

  const filesAfter = await fs.readdir(logDir);
  const previousMonthFile = filesAfter.find((f) => f.startsWith(previousMonthDate));
  expect(previousMonthFile).toBeDefined();
  return previousMonthDate;
};
