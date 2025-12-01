import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import pino from "pino";
import { createLogger, resetLogRegistry } from "../src/index";
import type { PinoLoggerExtended } from "../src/types";

const BENCHMARK_DURATION_MS = 5000; // 5 seconds per test
const CONCURRENT_REQUESTS = 100;
const BENCHMARK_LOG_DIR = "./logs-benchmark";
const BENCHMARK_RESULTS_FILE = "./tests/benchmark-results.txt";

// Parse command line flags
const INCLUDE_CONSOLE_TEST = process.argv.includes("--with-console");

interface BenchmarkResult {
  name: string;
  totalRequests: number;
  duration: number;
  requestsPerSecond: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
}

async function cleanupBenchmarkDir() {
  try {
    await fs.rm(BENCHMARK_LOG_DIR, { recursive: true });
  } catch { }
}

async function runBenchmark(
  name: string,
  setupServer: () => Hono,
  suppressConsole = false
): Promise<BenchmarkResult> {
  // Suppress console output if requested (for toConsole: true test)
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  if (suppressConsole) {
    process.stdout.write = () => true;
  }

  const app = setupServer();
  const server = Bun.serve({
    port: 0, // Random available port
    fetch: app.fetch,
  });

  const baseUrl = `http://localhost:${server.port}`;
  const latencies: number[] = [];
  let totalRequests = 0;
  let running = true;

  const startTime = performance.now();

  // Stop after duration
  const timeout = setTimeout(() => {
    running = false;
  }, BENCHMARK_DURATION_MS);

  // Run concurrent request workers
  const workers = Array.from({ length: CONCURRENT_REQUESTS }, async () => {
    while (running) {
      const reqStart = performance.now();
      try {
        const response = await fetch(`${baseUrl}/api/test`);
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

  const endTime = performance.now();
  const duration = endTime - startTime;

  server.stop(true);

  // Restore console output
  if (suppressConsole) {
    process.stdout.write = originalStdoutWrite;
  }

  // Reset logger registry for next test
  resetLogRegistry();
  await cleanupBenchmarkDir();

  // Wait a bit for cleanup
  await new Promise((resolve) => setTimeout(resolve, 500));

  const avgLatency = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;

  return {
    name,
    totalRequests,
    duration,
    requestsPerSecond: (totalRequests / duration) * 1000,
    avgLatency,
    minLatency: latencies.length > 0 ? Math.min(...latencies) : 0,
    maxLatency: latencies.length > 0 ? Math.max(...latencies) : 0,
  };
}

// Generate a random request ID (simulates UUID-like behavior)
function generateRequestId(): string {
  const chars = "abcdef0123456789";
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
    if (i === 7 || i === 11 || i === 15 || i === 19) id += "-";
  }
  return id;
}

// Generate a controlled random string of specified length
function generateRandomPayload(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function createServer(logger?: pino.Logger | PinoLoggerExtended) {
  const app = new Hono();
  if (logger) {
    app.use(async (c, next) => {
      // Simulate realistic request logging with varied payload
      const requestId = generateRequestId();
      const payload = generateRandomPayload(64); // 64 char random string
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

// Test 1: No logger (baseline)
function createBaselineServer(): Hono {
  return createServer();
}

// Test 2: Raw pino (silent - no output)
function createPinoSilentServer(): Hono {
  const logger = pino({ level: "silent" });
  return createServer(logger);
}

// Test 3: Raw pino with file destination (sync write)
function createPinoFileServer(): Hono {
  const logFile = path.join(BENCHMARK_LOG_DIR, "pino-raw.log");
  // Ensure directory exists
  try {
    require("node:fs").mkdirSync(BENCHMARK_LOG_DIR, { recursive: true });
  } catch { }
  const dest = pino.destination({ dest: logFile, sync: false });
  const logger = pino({ level: "info" }, dest);
  return createServer(logger);
}

// Test 4: pino-api-logger with default buffer settings (toConsole: false)
// Defaults: flushInterval: 200ms, maxBufferLines: 500, maxBufferKilobytes: 1024
function createLoggerDefaultBufferServer(): Hono {
  const logger = createLogger({
    logDir: BENCHMARK_LOG_DIR,
    toConsole: false,
    runArchiveOnCreation: false,
  });
  return createServer(logger);
}

// Test 5: pino-api-logger with high buffer values (toConsole: false)
// High: flushInterval: 1000ms, maxBufferLines: 2000, maxBufferKilobytes: 4096
function createLoggerHighBufferServer(): Hono {
  const logger = createLogger({
    logDir: BENCHMARK_LOG_DIR,
    toConsole: false,
    runArchiveOnCreation: false,
    flushInterval: 1000, // 1 second flush interval
    maxBufferLines: 2000, // 2000 lines buffer
    maxBufferKilobytes: 4096, // 4MB buffer
  });
  return createServer(logger);
}

// Test 6: pino-api-logger with minimal buffer values (toConsole: false)
// Minimal: flushInterval: 20ms, maxBufferLines: 1, maxBufferKilobytes: 1
function createLoggerMinimalBufferServer(): Hono {
  const logger = createLogger({
    logDir: BENCHMARK_LOG_DIR,
    toConsole: false,
    runArchiveOnCreation: false,
    flushInterval: 20, // Minimum allowed (20ms)
    maxBufferLines: 1, // Minimum - flush after every line
    maxBufferKilobytes: 1, // Minimum - 1KB buffer
  });
  return createServer(logger);
}

// Test 7: pino-api-logger with toConsole: true (with stdout pretty printing)
function createLoggerWithConsoleServer(): Hono {
  const logger = createLogger({
    logDir: BENCHMARK_LOG_DIR,
    toConsole: true,
    runArchiveOnCreation: false,
  });
  return createServer(logger);
}

function formatResult(result: BenchmarkResult): string {
  const w = 50; // inner width
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
  const c1 = 40; // Test name column
  const c2 = 12; // Req/sec column
  const c3 = 14; // vs Baseline column
  // Inner width: (c1+2) + (c2+2) + (c3+2) + 2 separators
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

async function main() {
  console.log("\n🚀 Starting Pino API Logger Benchmark\n");
  console.log(`Duration per test: ${BENCHMARK_DURATION_MS / 1000}s`);
  console.log(`Concurrent workers: ${CONCURRENT_REQUESTS}`);
  if (!INCLUDE_CONSOLE_TEST) {
    console.log(`\n💡 Tip: Run with --with-console to include toConsole: true test`);
  }
  console.log("");

  await cleanupBenchmarkDir();

  // Initialize results file with header
  const header = `Pino API Logger Benchmark Results
Generated: ${new Date().toISOString()}
Duration per test: ${BENCHMARK_DURATION_MS / 1000}s
Concurrent workers: ${CONCURRENT_REQUESTS}
${"═".repeat(79)}
`;
  await fs.writeFile(BENCHMARK_RESULTS_FILE, header);

  const results: BenchmarkResult[] = [];

  // Run tests sequentially
  const tests: Array<{ name: string; setup: () => Hono; suppressConsole: boolean; warn: boolean }> = [
    { name: "1. No Logger (Baseline)", setup: createBaselineServer, suppressConsole: false, warn: false },
    { name: "2. Pino (silent - no output)", setup: createPinoSilentServer, suppressConsole: false, warn: false },
    { name: "3. Pino (file destination - sync false)", setup: createPinoFileServer, suppressConsole: false, warn: false },
    { name: "4. pino-api-logger (default buffer)", setup: createLoggerDefaultBufferServer, suppressConsole: false, warn: false },
    { name: "5. pino-api-logger (high buffer)", setup: createLoggerHighBufferServer, suppressConsole: false, warn: false },
    { name: "6. pino-api-logger (min buffer)", setup: createLoggerMinimalBufferServer, suppressConsole: false, warn: false },
  ];

  // Only include toConsole test if explicitly requested (it floods the terminal)
  if (INCLUDE_CONSOLE_TEST) {
    tests.push({ name: "7. pino-api-logger (console)", setup: createLoggerWithConsoleServer, suppressConsole: false, warn: true });
  }

  for (const test of tests) {
    if (test.warn) {
      console.log("\n⚠️  Note: The following test outputs logs to console (may flood terminal)");
    }
    console.log(`\n⏱️  Running: ${test.name}...`);
    const result = await runBenchmark(test.name, test.setup, test.suppressConsole);
    results.push(result);

    const formattedResult = formatResult(result);
    console.log(formattedResult);

    // Append result to file
    await fs.appendFile(BENCHMARK_RESULTS_FILE, `${formattedResult}\n`);
  }

  // Print separator before final comparison
  console.log(`\n${"═".repeat(79)}`);

  // Print and write comparison
  const comparison = formatComparison(results);
  console.log(comparison);

  // Append comparison to file
  await fs.appendFile(BENCHMARK_RESULTS_FILE, `\n${"═".repeat(79)}\n${comparison}\n`);

  console.log("\n✅ Benchmark complete!");
  console.log(`📄 Results saved to: ${BENCHMARK_RESULTS_FILE}\n`);
}

main().catch(console.error);

