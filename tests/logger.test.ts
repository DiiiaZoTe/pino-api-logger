import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../src/index";
import { describe, it, expect } from "bun:test";

const TEST_LOG_DIR = "./logs-test";
const TEST_ARCHIVE_DIR = "archives-test";

const todayDate = new Date().toISOString().slice(0, 10);
const todayFile = `${todayDate}.log`;
const todayFilePath = path.join(TEST_LOG_DIR, todayFile);

try {
  console.log("Removing test log directory if it exists...");
  await fs.rm(TEST_LOG_DIR, { recursive: true });
} catch { }

describe("Logger Package", () => {
  // remove test log directory
  it("should create a logger instance", () => {
    const logger = createLogger({ logDir: TEST_LOG_DIR, runArchiveOnCreation: false });
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should write log lines to a daily file + test min flush interval", async () => {
    const logger = createLogger({ logDir: TEST_LOG_DIR, flushInterval: 10, runArchiveOnCreation: false });
    console.log("test 1", logger.getParams());
    logger.info("Test log line");

    // wait a short moment for the buffer to flush
    await new Promise((resolve) => setTimeout(resolve, 200));

    const files = await fs.readdir(TEST_LOG_DIR);
    expect(files.length).toBeGreaterThan(0);

    const todayFile = files.find(f => f.endsWith(".log"));
    expect(todayFile).toBeDefined();

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("Test log line");
  });

  it("should flush immediately when buffer is full", async () => {
    const logger = createLogger({ logDir: TEST_LOG_DIR, maxBufferLines: 1, runArchiveOnCreation: false });
    console.log("test 2", logger.getParams());
    logger.info("Line 1");
    logger.info("Line 2");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("Line 1");
    expect(content).toContain("Line 2");
  });

  it("should flush when buffer is full by disk size", async () => {
    const logger = createLogger({ logDir: TEST_LOG_DIR, maxBufferKilobytes: 1, flushInterval: 300, runArchiveOnCreation: false });
    console.log("test 3", logger.getParams());
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

  it("should work with child loggers", async () => {
    const logger = createLogger({ logDir: TEST_LOG_DIR, maxBufferLines: 1, runArchiveOnCreation: false });
    const child = logger.child({ request: "child-test" });
    console.log("test 4", logger.getParams());
    child.info("child log line");
    child.error({ test: "child-error-test" });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const content = await fs.readFile(todayFilePath, "utf-8");
    expect(content).toContain("child-test");
    expect(content).toContain("child log line");
    expect(content).toContain("child-error-test");
  });

  it("should archive logs monthly", async () => {
    const previousMonthDate = await createCopyOfTodayFileMinusXDays();
    // create the logger instance, it whould archive the previous month file
    const _logger = createLogger({ logDir: TEST_LOG_DIR, archiveDir: TEST_ARCHIVE_DIR, archiveLogging: true });
    // wait for the archive to happen (1 second lets say)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const filesAfterArchive = await fs.readdir(TEST_LOG_DIR);
    console.log("filesAfterArchive", filesAfterArchive);

    // we should have 1 log file and 1 archive folder with the archive file
    expect(filesAfterArchive.length).toBe(2);
    expect(filesAfterArchive.find(f => f.endsWith(".log"))).toBeDefined();
    // the archive folder should have the archive file
    const archiveFolder = filesAfterArchive.find(f => f.startsWith(TEST_ARCHIVE_DIR));
    expect(archiveFolder).toBeDefined();
    const archiveFiles = await fs.readdir(path.join(TEST_LOG_DIR, TEST_ARCHIVE_DIR));
    // the archive folder should contain one archive file
    expect(archiveFiles.length).toBe(1);
    const archiveFile = archiveFiles[0];
    expect(archiveFile).toBeDefined();
    expect(archiveFile.startsWith(previousMonthDate.slice(0, 7))).toBe(true);
    expect(archiveFile.endsWith(".tar.gz")).toBe(true);
  })

  it("should schedule the next archive run", async () => {
    const previousMonthDate = await createCopyOfTodayFileMinusXDays(62);
    const _logger = createLogger({ logDir: TEST_LOG_DIR, runArchiveOnCreation: false, archiveCron: '*/2 * * * * *', archiveDir: TEST_ARCHIVE_DIR, archiveLogging: true });
    // check that the archive file is not yet created (waiting for the interval to pass)
    const archiveFilesBefore = await fs.readdir(path.join(TEST_LOG_DIR, TEST_ARCHIVE_DIR));
    // we shouldn't find the archive for previousMonthDate
    expect(archiveFilesBefore.find(f => f.startsWith(previousMonthDate.slice(0, 7)))).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const archiveFilesAfter = await fs.readdir(path.join(TEST_LOG_DIR, TEST_ARCHIVE_DIR));
    // we should find the archive for previousMonthDate
    expect(archiveFilesAfter.find(f => f.startsWith(previousMonthDate.slice(0, 7)))).toBeDefined();
    // we should have 2 archive files now
    expect(archiveFilesAfter.length).toBe(2);
  })
});

const createCopyOfTodayFileMinusXDays = async (x = 31) => {
  // start by taking the current date log and changing the date to the previous month
  const files = await fs.readdir(TEST_LOG_DIR);
  const todayFile = files.find(f => f.endsWith(".log"));
  expect(todayFile).toBeDefined()
  if (!todayFile) return "";
  const todayDate = todayFile.split(".")[0];
  // create a new file for the previous month (-31 days)
  const previousMonthDate = new Date(new Date(todayDate).setDate(new Date(todayDate).getDate() - x)).toISOString().slice(0, 10);
  // copy the today file to the previous month date
  await fs.copyFile(path.join(TEST_LOG_DIR, todayFile), path.join(TEST_LOG_DIR, `${previousMonthDate}.log`));

  const filesAfter = await fs.readdir(TEST_LOG_DIR);
  const previousMonthFile = filesAfter.find(f => f.startsWith(previousMonthDate));
  expect(previousMonthFile).toBeDefined();
  return previousMonthDate;
}