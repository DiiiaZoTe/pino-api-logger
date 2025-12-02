import fs from "node:fs/promises";
import path from "node:path";
import { createLogger, resetLogRegistry } from "../src/index";
import { describe, it, expect, afterEach } from "bun:test";

const TEST_LOG_BASE_DIR = "./logs-test";
const TEST_ARCHIVE_DIR = "archives";

const todayDate = new Date().toISOString().slice(0, 10);
const todayFile = `${todayDate}.log`;

// Helper to get log dir for a specific test
const getTestLogDir = (testNum: string) => path.join(TEST_LOG_BASE_DIR, `test-${testNum}`);
const getTodayFilePath = (testNum: string) => path.join(getTestLogDir(testNum), todayFile);

try {
  console.log("Removing test log directory if it exists...");
  await fs.rm(TEST_LOG_BASE_DIR, { recursive: true });
} catch { }

describe("Logger Package", () => {
  // Reset registry after each test to ensure isolation
  afterEach(() => {
    resetLogRegistry();
  });

  it("01 - should create a logger instance", () => {
    const logDir = getTestLogDir("01");
    const logger = createLogger({ logDir, runArchiveOnCreation: false });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("02 - should write log lines to a daily file + test min flush interval", async () => {
    const logDir = getTestLogDir("02");
    const todayFilePath = getTodayFilePath("02");
    const logger = createLogger({ logDir, flushInterval: 10, runArchiveOnCreation: false });
    logger.info("Test log line");

    // wait a short moment for the buffer to flush
    await new Promise((resolve) => setTimeout(resolve, 200));

    const files = await fs.readdir(logDir);
    expect(files.length).toBeGreaterThan(0);

    const logFile = files.find(f => f.endsWith(".log"));
    expect(logFile).toBeDefined();

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("Test log line");
  });

  it("03 - should flush immediately when buffer is full", async () => {
    const logDir = getTestLogDir("03");
    const todayFilePath = getTodayFilePath("03");
    const logger = createLogger({ logDir, maxBufferLines: 1, runArchiveOnCreation: false });
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
    const logger = createLogger({ logDir, maxBufferKilobytes: 1, flushInterval: 300, runArchiveOnCreation: false });
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
    const logger = createLogger({ logDir, maxBufferLines: 1, runArchiveOnCreation: false });
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
    const _logger = createLogger({ logDir, archiveDir: TEST_ARCHIVE_DIR, archiveLogging: true });
    // wait for the archive to happen (1 second lets say)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const filesAfterArchive = await fs.readdir(logDir);

    // we should have 1 log file and 1 archive folder with the archive file
    expect(filesAfterArchive.length).toBe(2);
    expect(filesAfterArchive.find(f => f.endsWith(".log"))).toBeDefined();
    // the archive folder should have the archive file
    const archiveFolder = filesAfterArchive.find(f => f.startsWith(TEST_ARCHIVE_DIR));
    expect(archiveFolder).toBeDefined();
    const archiveFiles = await fs.readdir(path.join(logDir, TEST_ARCHIVE_DIR));
    // the archive folder should contain one archive file
    expect(archiveFiles.length).toBe(1);
    const archiveFile = archiveFiles[0];
    expect(archiveFile).toBeDefined();
    expect(archiveFile.startsWith(previousMonthDate.slice(0, 7))).toBe(true);
    expect(archiveFile.endsWith(".tar.gz")).toBe(true);
  });

  it("07 - should schedule the next archive run", async () => {
    const logDir = getTestLogDir("07");
    // First create a log file for today so we have something to copy
    const logger1 = createLogger({ logDir, runArchiveOnCreation: false });
    logger1.info("Initial log line");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await resetLogRegistry();

    const previousMonthDate = await createCopyOfTodayFileMinusXDays(logDir, 62);
    const _logger = createLogger({ logDir, runArchiveOnCreation: false, archiveCron: '*/2 * * * * *', archiveDir: TEST_ARCHIVE_DIR, archiveLogging: true });

    // Ensure archive dir exists for checking
    try {
      await fs.mkdir(path.join(logDir, TEST_ARCHIVE_DIR), { recursive: true });
    } catch { }

    // check that the archive file is not yet created (waiting for the interval to pass)
    const archiveFilesBefore = await fs.readdir(path.join(logDir, TEST_ARCHIVE_DIR));
    // we shouldn't find the archive for previousMonthDate
    expect(archiveFilesBefore.find(f => f.startsWith(previousMonthDate.slice(0, 7)))).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const archiveFilesAfter = await fs.readdir(path.join(logDir, TEST_ARCHIVE_DIR));
    // we should find the archive for previousMonthDate
    expect(archiveFilesAfter.find(f => f.startsWith(previousMonthDate.slice(0, 7)))).toBeDefined();
    // we should have 1 archive file now
    expect(archiveFilesAfter.length).toBe(1);
  });

  it("08 - should support custom pino options", async () => {
    const logDir = getTestLogDir("08");
    const todayFilePath = getTodayFilePath("08");
    const logger = createLogger({
      logDir,
      maxBufferLines: 1,
      runArchiveOnCreation: false,
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
    const lines = content.trim().split("\n").map(line => JSON.parse(line));
    const logLine = lines.find(l => l.message === "Custom pino options test");

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
      maxBufferLines: 1,
      runArchiveOnCreation: false,
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
    const lines = content.trim().split("\n").map(line => JSON.parse(line));
    const logLine = lines.find(l => l.msg === "Formatter merge test");

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
      archiveDir: TEST_ARCHIVE_DIR,
      disableArchiving: true,
      runArchiveOnCreation: true, // Would normally trigger archive, but disabled
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

    // Create a main log file that exceeds 1MB (the minimum maxDailyLogSizeMegabytes)
    const mainLogPath = path.join(logDir, todayFile);
    const largeContent = "x".repeat(1.1 * 1024 * 1024); // ~1.1MB
    await fs.writeFile(mainLogPath, largeContent);

    // Create logger with 1MB max daily size - should immediately use overflow
    const logger = createLogger({
      logDir,
      maxDailyLogSizeMegabytes: 1,
      maxBufferLines: 1,
      runArchiveOnCreation: false,
    });

    logger.info("This should go to overflow file");

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check that an overflow file was created
    const files = await fs.readdir(logDir);
    const overflowFile = files.find(
      (f) => f.startsWith(todayDate) && f !== todayFile && f.endsWith(".log")
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
      maxDailyLogSizeMegabytes: 1,
      maxBufferLines: 1,
      runArchiveOnCreation: false,
    });

    logger.info("This should append to existing overflow");

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check the files in the directory
    const files = await fs.readdir(logDir);
    const overflowFiles = files.filter(
      (f) => f.startsWith(todayDate) && f !== todayFile && f.endsWith(".log")
    );

    // Should only have the one existing overflow file (no new one created)
    expect(overflowFiles.length).toBe(1);
    expect(overflowFiles[0]).toBe(existingOverflowName);

    // Verify the new log was appended to the existing overflow file
    const overflowContent = await fs.readFile(existingOverflowPath, "utf-8");
    expect(overflowContent).toContain("Previous log entry"); // Original content preserved
    expect(overflowContent).toContain("This should append to existing overflow"); // New content appended
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
  let sourceFile = files.find(f => f.endsWith(".log"));

  if (!sourceFile) {
    // Create a minimal log file for today
    const todayFilePath = path.join(logDir, todayFile);
    await fs.writeFile(todayFilePath, `{"level":"info","time":"${new Date().toISOString()}","msg":"test"}\n`);
    sourceFile = todayFile;
  }

  const sourceDate = sourceFile.split(".")[0];
  // create a new file for the previous month (-x days)
  const previousMonthDate = new Date(new Date(sourceDate).setDate(new Date(sourceDate).getDate() - x)).toISOString().slice(0, 10);
  // copy the source file to the previous month date
  await fs.copyFile(path.join(logDir, sourceFile), path.join(logDir, `${previousMonthDate}.log`));

  const filesAfter = await fs.readdir(logDir);
  const previousMonthFile = filesAfter.find(f => f.startsWith(previousMonthDate));
  expect(previousMonthFile).toBeDefined();
  return previousMonthDate;
};
