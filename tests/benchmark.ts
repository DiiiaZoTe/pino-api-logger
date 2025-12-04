import cluster from "node:cluster";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import pino from "pino";
import { cleanupLogRegistry, createLogger } from "../src/index";
import type { PinoLoggerExtended } from "../src/types";

const BENCHMARK_DURATION_MS = 5000; // 5 seconds per test
const CONCURRENCY_PER_CORE = 1000; // concurrent requests per CPU core
const BENCHMARK_LOG_DIR_BASE = "./logs/benchmark/";
const BENCHMARK_LOG_DIR = `${BENCHMARK_LOG_DIR_BASE}test`;
const BENCHMARK_RESULTS_FILE = `${BENCHMARK_LOG_DIR_BASE}results.txt`;
const BENCHMARK_PORT = 54321; // Fixed port for cluster communication

// Parse command line flags
const INCLUDE_CONSOLE_TEST = process.argv.includes("--with-console");
const MULTI_CORE_MODE = process.argv.includes("--multi-core");
const CPU_COUNT = os.cpus().length;

interface BenchmarkResult {
  name: string;
  totalRequests: number;
  duration: number;
  requestsPerSecond: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
}

interface WorkerResult {
  latencies: number[];
  totalRequests: number;
}

interface WorkerMessage {
  type: "start" | "result" | "ready";
  config?: {
    url: string;
    durationMs: number;
    concurrency: number;
  };
  result?: WorkerResult;
}

// ============================================================================
// Utility Functions
// ============================================================================

async function createBenchmarkLogDir() {
  try {
    await fs.mkdir(BENCHMARK_LOG_DIR_BASE, { recursive: true });
  } catch { }
}

async function cleanupBenchmarkDir() {
  try {
    await fs.rm(BENCHMARK_LOG_DIR_BASE, { recursive: true });
  } catch { }
}

function generateRequestId(): string {
  const chars = "abcdef0123456789";
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
    if (i === 7 || i === 11 || i === 15 || i === 19) id += "-";
  }
  return id;
}

function generateRandomPayload(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ============================================================================
// Server Creation Functions
// ============================================================================

function createServer(logger?: pino.Logger | PinoLoggerExtended) {
  const app = new Hono();
  if (logger) {
    app.use(async (c, next) => {
      const requestId = generateRequestId();
      const payload = generateRandomPayload(64);
      logger.info(
        {
          requestId,
          method: c.req.method,
          path: c.req.path,
          payload,
          timestamp: Date.now(),
        },
        "Incoming request"
      );
      await next();
    });
  }
  app.get("/api/test", (c) => {
    return c.json({ message: "Hello World", timestamp: Date.now() });
  });
  return app;
}

type LoggerFactory = () => pino.Logger | PinoLoggerExtended | undefined;

const loggerFactories: Record<string, LoggerFactory> = {
  baseline: () => undefined,
  "pino-silent": () => pino({ level: "silent" }),
  "pino-file": () => {
    const logFile = path.join(`${BENCHMARK_LOG_DIR}-3`, "pino-raw.log");
    try {
      require("node:fs").mkdirSync(`${BENCHMARK_LOG_DIR}-3`, { recursive: true });
    } catch { }
    const dest = pino.destination({ dest: logFile, sync: false });
    return pino({ level: "info" }, dest);
  },
  "api-logger-default": () =>
    createLogger({
      logDir: `${BENCHMARK_LOG_DIR}-4`,
      console: { enabled: false },
      archive: { runOnCreation: false },
    }),
  "api-logger-high-buffer": () =>
    createLogger({
      logDir: `${BENCHMARK_LOG_DIR}-5`,
      console: { enabled: false },
      archive: { runOnCreation: false },
      file: {
        flushInterval: 1000,
        maxBufferLines: 2000,
        maxBufferKilobytes: 4096,
      },
    }),
  "api-logger-min-buffer": () =>
    createLogger({
      logDir: `${BENCHMARK_LOG_DIR}-6`,
      console: { enabled: false },
      archive: { runOnCreation: false },
      file: {
        flushInterval: 20,
        maxBufferLines: 1,
        maxBufferKilobytes: 1,
      },
    }),
  "api-logger-console": () =>
    createLogger({
      logDir: `${BENCHMARK_LOG_DIR}-7`,
      console: { enabled: true },
      archive: { runOnCreation: false },
    }),
};

// ============================================================================
// Benchmark Client (runs in worker processes)
// ============================================================================

async function runBenchmarkClient(url: string, durationMs: number, concurrency: number): Promise<WorkerResult> {
  const latencies: number[] = [];
  let totalRequests = 0;
  let running = true;

  const timeout = setTimeout(() => {
    running = false;
  }, durationMs);

  const workers = Array.from({ length: concurrency }, async () => {
    while (running) {
      const reqStart = performance.now();
      try {
        const response = await fetch(url);
        if (response.ok) {
          await response.text();
          const latency = performance.now() - reqStart;
          latencies.push(latency);
          totalRequests++;
        }
      } catch {
        // Ignore errors during shutdown
      }
    }
  });

  await Promise.all(workers);
  clearTimeout(timeout);

  return { latencies, totalRequests };
}

// ============================================================================
// Single-Core Benchmark (Original Implementation)
// ============================================================================

async function runSingleCoreBenchmark(
  name: string,
  loggerType: string,
  suppressConsole = false
): Promise<BenchmarkResult> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  if (suppressConsole) {
    process.stdout.write = () => true;
  }

  const logger = loggerFactories[loggerType]?.();
  const app = createServer(logger);
  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
  });

  const baseUrl = `http://localhost:${server.port}/api/test`;
  const startTime = performance.now();

  const result = await runBenchmarkClient(baseUrl, BENCHMARK_DURATION_MS, CONCURRENCY_PER_CORE);

  const endTime = performance.now();
  const duration = endTime - startTime;

  server.stop(true);

  if (suppressConsole) {
    process.stdout.write = originalStdoutWrite;
  }

  cleanupLogRegistry();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const avgLatency = result.latencies.length > 0
    ? result.latencies.reduce((a, b) => a + b, 0) / result.latencies.length
    : 0;

  return {
    name,
    totalRequests: result.totalRequests,
    duration,
    requestsPerSecond: (result.totalRequests / duration) * 1000,
    avgLatency,
    minLatency: result.latencies.length > 0 ? Math.min(...result.latencies) : 0,
    maxLatency: result.latencies.length > 0 ? Math.max(...result.latencies) : 0,
  };
}

// ============================================================================
// Multi-Core Benchmark (Cluster-based Implementation)
// ============================================================================

async function runMultiCoreBenchmark(
  name: string,
  loggerType: string,
  suppressConsole = false
): Promise<BenchmarkResult> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  if (suppressConsole) {
    process.stdout.write = () => true;
  }

  const logger = loggerFactories[loggerType]?.();
  const app = createServer(logger);

  // Start server on fixed port
  const server = Bun.serve({
    port: BENCHMARK_PORT,
    fetch: app.fetch,
    reusePort: true,
  });

  const baseUrl = `http://localhost:${BENCHMARK_PORT}/api/test`;
  const startTime = performance.now();

  // Fork workers and collect results
  const workerResults: WorkerResult[] = [];
  const workerPromises: Promise<void>[] = [];

  for (let i = 0; i < CPU_COUNT; i++) {
    const worker = cluster.fork();

    const promise = new Promise<void>((resolve) => {
      worker.on("message", (msg: WorkerMessage) => {
        if (msg.type === "ready") {
          // Worker is ready, send start config
          worker.send({
            type: "start",
            config: {
              url: baseUrl,
              durationMs: BENCHMARK_DURATION_MS,
              concurrency: CONCURRENCY_PER_CORE,
            },
          } as WorkerMessage);
        } else if (msg.type === "result" && msg.result) {
          workerResults.push(msg.result);
          worker.disconnect();
          resolve();
        }
      });
    });

    workerPromises.push(promise);
  }

  // Wait for all workers to complete
  await Promise.all(workerPromises);

  const endTime = performance.now();
  const duration = endTime - startTime;

  server.stop(true);

  if (suppressConsole) {
    process.stdout.write = originalStdoutWrite;
  }

  cleanupLogRegistry();
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Aggregate results from all workers
  const allLatencies: number[] = [];
  let totalRequests = 0;

  for (const result of workerResults) {
    allLatencies.push(...result.latencies);
    totalRequests += result.totalRequests;
  }

  const avgLatency = allLatencies.length > 0
    ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length
    : 0;

  return {
    name,
    totalRequests,
    duration,
    requestsPerSecond: (totalRequests / duration) * 1000,
    avgLatency,
    minLatency: allLatencies.length > 0 ? Math.min(...allLatencies) : 0,
    maxLatency: allLatencies.length > 0 ? Math.max(...allLatencies) : 0,
  };
}

// ============================================================================
// Formatting Functions
// ============================================================================

function formatResult(result: BenchmarkResult): string {
  const w = 50;
  const row = (label: string, value: string, unit = "") => {
    const content = `${label}${value}${unit}`;
    return `│ ${content.padEnd(w)} │`;
  };
  const line = "─".repeat(w + 2);

  return `
┌${line}┐
│ ${result.name.padEnd(w)} │
├${line}┤
${row("Total Requests:  ", result.totalRequests.toString().padStart(12))}
${row("Duration:        ", (result.duration / 1000).toFixed(2).padStart(12), " s")}
${row("Requests/sec:    ", result.requestsPerSecond.toFixed(2).padStart(12))}
${row("Avg Latency:     ", result.avgLatency.toFixed(2).padStart(12), " ms")}
${row("Min Latency:     ", result.minLatency.toFixed(2).padStart(12), " ms")}
${row("Max Latency:     ", result.maxLatency.toFixed(2).padStart(12), " ms")}
└${line}┘`;
}

function formatComparison(results: BenchmarkResult[]): string {
  const baseline = results[0].requestsPerSecond;
  const c1 = 40;
  const c2 = 12;
  const c3 = 14;
  const innerWidth = c1 + c2 + c3 + 8;

  const hLine = (l: string, r: string, sep: string) =>
    `${l}${"═".repeat(c1 + 2)}${sep}${"═".repeat(c2 + 2)}${sep}${"═".repeat(c3 + 2)}${r}`;

  const title = "BENCHMARK COMPARISON";
  const padLeft = Math.floor((innerWidth - title.length) / 2);
  const padRight = innerWidth - title.length - padLeft;

  let output = `
${hLine("╔", "╗", "═")}
║${" ".repeat(padLeft)}${title}${" ".repeat(padRight)}║
${hLine("╠", "╣", "╦")}
║ ${"Test Name".padEnd(c1)} ║ ${"Req/sec".padStart(c2)} ║ ${"vs Baseline".padStart(c3)} ║
${hLine("╠", "╣", "╬")}`;

  for (const result of results) {
    const diff = ((result.requestsPerSecond / baseline) * 100 - 100).toFixed(1);
    const diffStr = result === results[0] ? "baseline" : `${diff}%`;
    output += `
║ ${result.name.padEnd(c1)} ║ ${result.requestsPerSecond.toFixed(0).padStart(c2)} ║ ${diffStr.padStart(c3)} ║`;
  }

  output += `
${hLine("╚", "╝", "╩")}`;

  return output;
}

// ============================================================================
// Worker Process Entry Point
// ============================================================================

async function workerMain() {
  // Signal ready to primary
  process.send?.({ type: "ready" } as WorkerMessage);

  // Wait for start command
  process.on("message", async (msg: WorkerMessage) => {
    if (msg.type === "start" && msg.config) {
      const { url, durationMs, concurrency } = msg.config;
      const result = await runBenchmarkClient(url, durationMs, concurrency);
      process.send?.({ type: "result", result } as WorkerMessage);
    }
  });
}

// ============================================================================
// Primary Process Entry Point
// ============================================================================

async function primaryMain() {
  await cleanupBenchmarkDir();
  await createBenchmarkLogDir();

  const mode = MULTI_CORE_MODE ? "multi-core" : "single-core";

  console.log("\n🚀 Starting Pino API Logger Benchmark\n");
  console.log(`Mode: ${mode}${MULTI_CORE_MODE ? ` (${CPU_COUNT} CPU cores)` : ""}`);
  console.log(`Duration per test: ${BENCHMARK_DURATION_MS / 1000}s`);
  console.log(`Concurrency per core: ${CONCURRENCY_PER_CORE}${MULTI_CORE_MODE ? ` (${CONCURRENCY_PER_CORE * CPU_COUNT} total)` : ""}`);
  if (!INCLUDE_CONSOLE_TEST) {
    console.log(`\n💡 Tip: Run with --with-console to include toConsole: true test`);
  }
  if (!MULTI_CORE_MODE) {
    console.log(`💡 Tip: Run with --multi-core to utilize all ${CPU_COUNT} CPU cores`);
  }
  console.log("");

  const totalConcurrency = MULTI_CORE_MODE ? CONCURRENCY_PER_CORE * CPU_COUNT : CONCURRENCY_PER_CORE;
  const header = `Pino API Logger Benchmark Results
Generated: ${new Date().toISOString()}
Mode: ${mode}${MULTI_CORE_MODE ? ` (${CPU_COUNT} CPU cores)` : ""}
Duration per test: ${BENCHMARK_DURATION_MS / 1000}s
Concurrency per core: ${CONCURRENCY_PER_CORE}${MULTI_CORE_MODE ? ` (${totalConcurrency} total)` : ""}
${"═".repeat(79)}
`;
  await fs.writeFile(BENCHMARK_RESULTS_FILE, header);

  const results: BenchmarkResult[] = [];

  const runBenchmark = MULTI_CORE_MODE ? runMultiCoreBenchmark : runSingleCoreBenchmark;

  const tests: Array<{
    name: string;
    loggerType: string;
    suppressConsole: boolean;
    warn: boolean;
  }> = [
      { name: "1. No Logger (Baseline)", loggerType: "baseline", suppressConsole: false, warn: false },
      { name: "2. Pino (silent - no output)", loggerType: "pino-silent", suppressConsole: false, warn: false },
      { name: "3. Pino (file destination - sync false)", loggerType: "pino-file", suppressConsole: false, warn: false },
      { name: "4. pino-api-logger (default buffer)", loggerType: "api-logger-default", suppressConsole: false, warn: false },
      { name: "5. pino-api-logger (high buffer)", loggerType: "api-logger-high-buffer", suppressConsole: false, warn: false },
      { name: "6. pino-api-logger (min buffer)", loggerType: "api-logger-min-buffer", suppressConsole: false, warn: false },
    ];

  if (INCLUDE_CONSOLE_TEST) {
    tests.push({
      name: "7. pino-api-logger (console)",
      loggerType: "api-logger-console",
      suppressConsole: false,
      warn: true,
    });
  }

  for (const test of tests) {
    if (test.warn) {
      console.log("\n⚠️  Note: The following test outputs logs to console (may flood terminal)");
    }
    console.log(`\n⏱️  Running: ${test.name}...`);
    const result = await runBenchmark(test.name, test.loggerType, test.suppressConsole);
    results.push(result);

    const formattedResult = formatResult(result);
    console.log(formattedResult);

    await fs.appendFile(BENCHMARK_RESULTS_FILE, `${formattedResult}\n`);
  }

  console.log(`\n${"═".repeat(79)}`);

  const comparison = formatComparison(results);
  console.log(comparison);

  await fs.appendFile(BENCHMARK_RESULTS_FILE, `\n${"═".repeat(79)}\n${comparison}\n`);

  console.log("\n✅ Benchmark complete!");
  console.log(`📄 Results saved to: ${BENCHMARK_RESULTS_FILE}\n`);
}

// ============================================================================
// Entry Point
// ============================================================================

if (cluster.isPrimary) {
  primaryMain().catch(console.error);
} else {
  workerMain().catch(console.error);
}
