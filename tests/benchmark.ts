import cluster from "node:cluster";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import autocannon from "autocannon";
import { Hono } from "hono";
import pino from "pino";
import { cleanupLogRegistry, createLogger } from "../src/index";
import type { PinoLoggerExtended } from "../src/types";

// ============================================================================
// Configuration
// ============================================================================

const BENCHMARK_DURATION_SEC = 10; // seconds per test
const WARMUP_DURATION_SEC = 3; // seconds for warm-up
const BENCHMARK_CONNECTIONS = 500; // concurrent connections
const BENCHMARK_PIPELINING = 20; // requests per connection
const BENCHMARK_WORKERS = 4; // autocannon worker threads (experimental)
const BENCHMARK_LOG_DIR_BASE = "./logs/benchmark/";
const BENCHMARK_LOG_DIR = `${BENCHMARK_LOG_DIR_BASE}test`;
const BENCHMARK_RESULTS_FILE = `${BENCHMARK_LOG_DIR_BASE}results.txt`;
const BENCHMARK_PORT = 54322;

// Parse command line flags
const INCLUDE_CONSOLE_TEST = process.argv.includes("--with-console");
const MULTI_CORE_MODE = process.argv.includes("--multi-core");
const CPU_COUNT = os.cpus().length;

// ============================================================================
// Types
// ============================================================================

interface BenchmarkResult {
  name: string;
  requests: number;
  duration: number;
  requestsPerSecond: number;
  latencyAvg: number;
  latencyP50: number;
  latencyP99: number;
  throughputMBps: number;
  errors: number;
}

interface TestConfig {
  name: string;
  loggerType: string;
  suppressConsole: boolean;
  warn: boolean;
  isWarmup?: boolean;
  duration?: number;
}

interface ClusterMessage {
  type: "ready" | "start" | "stop" | "stopped";
  loggerType?: string;
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
// Server Creation
// ============================================================================

function createHonoApp(logger?: pino.Logger | PinoLoggerExtended) {
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
    const logFile = path.join(`${BENCHMARK_LOG_DIR}-pino`, "pino-raw.log");
    try {
      require("node:fs").mkdirSync(`${BENCHMARK_LOG_DIR}-pino`, { recursive: true });
    } catch { }
    const dest = pino.destination({ dest: logFile, sync: false, minLength: 4096 });
    return pino({ level: "info" }, dest);
  },
  "api-logger-default": () =>
    createLogger({
      logDir: `${BENCHMARK_LOG_DIR}-default`,
      console: { enabled: false },
      archive: { runOnCreation: false },
    }),
  "api-logger-high-buffer": () =>
    createLogger({
      logDir: `${BENCHMARK_LOG_DIR}-high`,
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
      logDir: `${BENCHMARK_LOG_DIR}-min`,
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
      logDir: `${BENCHMARK_LOG_DIR}-console`,
      console: { enabled: true },
      archive: { runOnCreation: false },
    }),
};

// ============================================================================
// Single-Core Server
// ============================================================================

let currentServer: ReturnType<typeof Bun.serve> | null = null;

function startSingleCoreServer(loggerType: string): void {
  const logger = loggerFactories[loggerType]?.();
  const app = createHonoApp(logger);
  currentServer = Bun.serve({
    port: BENCHMARK_PORT,
    fetch: app.fetch,
    reusePort: true,
  });
}

function stopSingleCoreServer(): void {
  if (currentServer) {
    currentServer.stop(true);
    currentServer = null;
  }
  cleanupLogRegistry();
}

// ============================================================================
// Multi-Core Server (Worker Process)
// ============================================================================

function runWorkerServer(): void {
  let server: ReturnType<typeof Bun.serve> | null = null;

  process.on("message", (msg: ClusterMessage) => {
    if (msg.type === "start" && msg.loggerType) {
      const logger = loggerFactories[msg.loggerType]?.();
      const app = createHonoApp(logger);
      server = Bun.serve({
        port: BENCHMARK_PORT,
        fetch: app.fetch,
        reusePort: true,
      });
      process.send?.({ type: "ready" } as ClusterMessage);
    } else if (msg.type === "stop") {
      if (server) {
        server.stop(true);
        server = null;
      }
      cleanupLogRegistry();
      process.send?.({ type: "stopped" } as ClusterMessage);
    }
  });

  // Signal that worker is initialized
  process.send?.({ type: "ready" } as ClusterMessage);
}

// ============================================================================
// Multi-Core Server Management (Primary Process)
// ============================================================================

let workers: ReturnType<typeof cluster.fork>[] = [];

async function startMultiCoreServer(loggerType: string): Promise<void> {
  workers = [];

  // Fork workers for each CPU
  for (let i = 0; i < CPU_COUNT; i++) {
    const worker = cluster.fork();
    workers.push(worker);
  }

  // Wait for all workers to be ready, then tell them to start
  const readyPromises = workers.map(
    (worker) =>
      new Promise<void>((resolve) => {
        const handler = (msg: ClusterMessage) => {
          if (msg.type === "ready") {
            worker.off("message", handler);
            resolve();
          }
        };
        worker.on("message", handler);
      })
  );

  await Promise.all(readyPromises);

  // Send start command to all workers
  const startPromises = workers.map(
    (worker) =>
      new Promise<void>((resolve) => {
        const handler = (msg: ClusterMessage) => {
          if (msg.type === "ready") {
            worker.off("message", handler);
            resolve();
          }
        };
        worker.on("message", handler);
        worker.send({ type: "start", loggerType } as ClusterMessage);
      })
  );

  await Promise.all(startPromises);
}

async function stopMultiCoreServer(): Promise<void> {
  // Send stop command to all workers
  const stopPromises = workers.map(
    (worker) =>
      new Promise<void>((resolve) => {
        const handler = (msg: ClusterMessage) => {
          if (msg.type === "stopped") {
            worker.off("message", handler);
            resolve();
          }
        };
        worker.on("message", handler);
        worker.send({ type: "stop" } as ClusterMessage);
      })
  );

  await Promise.all(stopPromises);

  // Disconnect all workers
  for (const worker of workers) {
    worker.disconnect();
  }

  workers = [];
}

// ============================================================================
// Autocannon Benchmark Runner
// ============================================================================

async function runAutocannonBenchmark(
  name: string,
  loggerType: string,
  suppressConsole = false,
  duration = BENCHMARK_DURATION_SEC
): Promise<BenchmarkResult> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  if (suppressConsole) {
    process.stdout.write = () => true;
  }

  // Start server(s)
  if (MULTI_CORE_MODE) {
    await startMultiCoreServer(loggerType);
  } else {
    startSingleCoreServer(loggerType);
  }

  // Give server time to stabilize
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Run autocannon
  const result = await new Promise<autocannon.Result>((resolve, reject) => {
    const instance = autocannon(
      {
        url: `http://localhost:${BENCHMARK_PORT}/api/test`,
        connections: BENCHMARK_CONNECTIONS,
        pipelining: BENCHMARK_PIPELINING,
        duration,
        workers: BENCHMARK_WORKERS,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );

    // Don't render the progress bar
    autocannon.track(instance, { renderProgressBar: false });
  });

  // Stop server(s)
  if (MULTI_CORE_MODE) {
    await stopMultiCoreServer();
  } else {
    stopSingleCoreServer();
  }

  if (suppressConsole) {
    process.stdout.write = originalStdoutWrite;
  }

  // Wait for cleanup
  await new Promise((resolve) => setTimeout(resolve, 500));

  return {
    name,
    requests: result.requests.total,
    duration: result.duration,
    requestsPerSecond: result.requests.average,
    latencyAvg: result.latency.average,
    latencyP50: result.latency.p50,
    latencyP99: result.latency.p99,
    throughputMBps: result.throughput.average / 1024 / 1024,
    errors: result.errors,
  };
}

// ============================================================================
// Formatting Functions
// ============================================================================

function formatResult(result: BenchmarkResult): string {
  const w = 54;
  const row = (label: string, value: string, unit = "") => {
    const content = `${label}${value}${unit}`;
    return `│ ${content.padEnd(w)} │`;
  };
  const line = "─".repeat(w + 2);

  return `
┌${line}┐
│ ${result.name.padEnd(w)} │
├${line}┤
${row("Total Requests:  ", result.requests.toLocaleString().padStart(16))}
${row("Duration:        ", result.duration.toFixed(2).padStart(16), " s")}
${row("Requests/sec:    ", result.requestsPerSecond.toFixed(2).padStart(16))}
${row("Latency (avg):   ", result.latencyAvg.toFixed(2).padStart(16), " ms")}
${row("Latency (p50):   ", result.latencyP50.toFixed(2).padStart(16), " ms")}
${row("Latency (p99):   ", result.latencyP99.toFixed(2).padStart(16), " ms")}
${row("Throughput:      ", result.throughputMBps.toFixed(2).padStart(16), " MB/s")}
${row("Errors:          ", result.errors.toString().padStart(16))}
└${line}┘`;
}

function formatComparison(results: BenchmarkResult[]): string {
  const baseline = results[0].requestsPerSecond;
  const c1 = 40;
  const c2 = 14;
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
║ ${result.name.padEnd(c1)} ║ ${result.requestsPerSecond.toFixed(0).padStart(c2)} ║ ${diffStr.padStart(c2)} ║`;
  }

  output += `
${hLine("╚", "╝", "╩")}`;

  return output;
}

// ============================================================================
// Primary Process Main
// ============================================================================

async function primaryMain() {
  await cleanupBenchmarkDir();
  await createBenchmarkLogDir();

  const mode = MULTI_CORE_MODE ? "multi-core" : "single-core";

  console.log("\n🚀 Starting Pino API Logger Benchmark (Autocannon)\n");
  console.log(`Mode: ${mode}${MULTI_CORE_MODE ? ` (${CPU_COUNT} server workers)` : ""}`);
  console.log(`Duration per test: ${BENCHMARK_DURATION_SEC}s`);
  console.log(`Connections: ${BENCHMARK_CONNECTIONS}`);
  console.log(`Pipelining: ${BENCHMARK_PIPELINING}`);
  console.log(`Client workers: ${BENCHMARK_WORKERS}`);
  if (!INCLUDE_CONSOLE_TEST) {
    console.log(`\n💡 Tip: Run with --with-console to include toConsole: true test`);
  }
  if (!MULTI_CORE_MODE) {
    console.log(`💡 Tip: Run with --multi-core to run server on all ${CPU_COUNT} CPU cores`);
  }
  console.log("");

  const header = `Pino API Logger Benchmark Results (Autocannon)
Generated: ${new Date().toISOString()}
Mode: ${mode}${MULTI_CORE_MODE ? ` (${CPU_COUNT} server workers)` : ""}
Duration per test: ${BENCHMARK_DURATION_SEC}s
Connections: ${BENCHMARK_CONNECTIONS}
Pipelining: ${BENCHMARK_PIPELINING}
Client workers: ${BENCHMARK_WORKERS}
${"═".repeat(79)}
`;
  await fs.writeFile(BENCHMARK_RESULTS_FILE, header);

  const results: BenchmarkResult[] = [];

  const tests: TestConfig[] = [
    // Warm-up run (results discarded) - primes JIT, TCP stack, memory allocator
    { name: "🔥 Warm-up", loggerType: "baseline", suppressConsole: false, warn: false, isWarmup: true, duration: WARMUP_DURATION_SEC },
    // Actual tests
    { name: "1. No Logger (Baseline)", loggerType: "baseline", suppressConsole: false, warn: false },
    { name: "2. Pino (silent - no output)", loggerType: "pino-silent", suppressConsole: false, warn: false },
    { name: "3. Pino (file destination)", loggerType: "pino-file", suppressConsole: false, warn: false },
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
    const result = await runAutocannonBenchmark(
      test.name,
      test.loggerType,
      test.suppressConsole,
      test.duration ?? BENCHMARK_DURATION_SEC
    );

    // Skip storing/displaying results for warm-up runs
    if (test.isWarmup) {
      console.log("✅ Warm-up complete\n");
      continue;
    }

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

  process.exit(0);
}

// ============================================================================
// Entry Point
// ============================================================================

if (cluster.isPrimary) {
  primaryMain().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runWorkerServer();
}

