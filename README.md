# pino-api-logger

A self-hosted, server-side API logger built on top of [Pino](https://github.com/pinojs/pino) with multi-stream writing, configurable rotation frequencies, buffered writes, flexible archiving, and log retention. Designed for Node.js and Bun projects.

## Features

- 🚀 **High Performance** — Built on Pino, one of the fastest Node.js loggers
- 📁 **Configurable Log Rotation** — Daily or hourly rotation frequency
- 📦 **Buffered Writes** — Configurable buffer size and flush interval for optimized I/O
- 🗜️ **Flexible Archiving** — Archive logs hourly, daily, weekly, or monthly
- 🧹 **Log Retention** — Automatically delete old logs and archives based on retention policy
- 🖥️ **Multi-Stream Output** — Writes to both console (with pretty printing) and file simultaneously
- 📏 **Max File Size Rotation** — Rotates logs when they exceed a configurable size limit
- 🔄 **Singleton Pattern** — Ensures one file writer per log directory, even with multiple logger instances
- 🎨 **Pretty Console Output** — Uses `pino-pretty` for readable development logs

This package provides **sensible defaults** for a production-ready logging setup while allowing you to customize Pino's configuration when needed.

**Defaults (can be overridden via `pinoOptions`):**
- Log format: JSON lines with ISO timestamps
- Formatter structure: `level` as string, `msg` always last
- Base options: `pid` and `hostname` excluded
- Multi-stream setup: file and/or console (at least one must be enabled)

**Managed internally (cannot be overridden):**
- Transport configuration (multi-stream to file + console)
- File rotation and buffered writes (when `file.enabled: true`)
- Archiving and retention scheduling

## Installation

```bash
# npm
npm install pino-api-logger

# yarn
yarn add pino-api-logger

# pnpm
pnpm add pino-api-logger

# bun
bun add pino-api-logger
```

## Quick Start

```typescript
import { createLogger } from "pino-api-logger";

const logger = createLogger();

logger.info("Hello, world!");
logger.warn({ userId: 123 }, "User logged in");
logger.error({ err: new Error("Something went wrong") }, "An error occurred");
```

## Configuration

The `createLogger` function accepts an options object with the following properties:

```typescript
import { createLogger } from "pino-api-logger";

const logger = createLogger({
  // Base options
  logDir: "logs",           // Directory to write logs (default: "logs")
  level: "info",            // Log level: trace, debug, info, warn, error, fatal (default: "info")

  // Custom Pino options (optional - override defaults)
  pinoOptions: {
    base: { service: "my-api" },  // Add service info to every log
    messageKey: "message",        // Use 'message' instead of 'msg'
    // ... any other pino.LoggerOptions (except transport)
  },

  // File options
  file: {
    enabled: true,                // Write to file (default: true)
    rotationFrequency: "daily",   // "hourly" | "daily" (default: "daily")
    flushInterval: 200,           // Buffer flush interval in ms (default: 200, min: 20)
    maxBufferLines: 500,          // Max lines to buffer before flush (default: 500, min: 1)
    maxBufferKilobytes: 1024,     // Max KB to buffer before flush (default: 1024, min: 1)
    maxLogSizeMegabytes: 100,     // Max log file size before overflow (default: 100MB, min: 1)
  },

  // Console options
  console: {
    enabled: true,                // Write to console (default: true)
    pretty: {                     // pino-pretty options for console output
      singleLine: false,
      colorize: true,
      ignore: "pid,hostname",
      translateTime: "yyyy-mm-dd HH:MM:ss.l",
    },
  },

  // Archive options
  archive: {
    frequency: "monthly",         // "hourly" | "daily" | "weekly" | "monthly" (default: "monthly")
    runOnCreation: true,          // Run archive check on logger creation (default: true)
    dir: "archives",              // Archive directory relative to logDir (default: "archives")
    logging: true,                // Log archive operations (default: true)
    disabled: false,              // Completely disable archiving (default: false)
  },

  // Retention options
  retention: {
    period: "30d",                // Delete logs/archives older than this (default: undefined)
  },
});
```

### Options Reference

#### Base Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logDir` | `string` | `"logs"` | Directory for log files |
| `level` | `string` | `"info"` | Pino default log level |
| `pinoOptions` | `CustomPinoOptions` | `undefined` | Custom Pino options to override defaults |

#### File Options (`file`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Write logs to file |
| `rotationFrequency` | `"hourly" \| "daily"` | `"daily"` | How often to rotate log files |
| `flushInterval` | `number` | `200` | Buffer flush interval (ms, min: 20) |
| `maxBufferLines` | `number` | `500` | Max buffered lines before flush (min: 1) |
| `maxBufferKilobytes` | `number` | `1024` | Max buffered KB before flush |
| `maxLogSizeMegabytes` | `number` | `100` | Max file size before overflow rotation |

#### Console Options (`console`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable console output via pino-pretty |
| `pretty` | `PrettyOptions` | See below | pino-pretty configuration |

#### Archive Options (`archive`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `frequency` | `"hourly" \| "daily" \| "weekly" \| "monthly"` | `"monthly"` | How often to archive logs |
| `runOnCreation` | `boolean` | `true` | Archive needed files immediately on startup |
| `dir` | `string` | `"archives"` | Archive output directory |
| `logging` | `boolean` | `true` | Log archiver operations |
| `disabled` | `boolean` | `false` | Completely disable the archiving process |

#### Retention Options (`retention`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `period` | `string` | `undefined` | Retention period (e.g., "7d", "3m", "1y") |

### Log Retention Format

The `retention.period` option accepts a string in the format `<number><unit>`:

| Unit | Description | Example |
|------|-------------|---------|
| `h` | Hours (rolling, checked hourly) | `"24h"` |
| `d` | Days (rolling, checked daily) | `"7d"`, `"90d"` |
| `w` | Weeks (rolling, checked weekly) | `"2w"` |
| `m` | Months (calendar-based, checked monthly) | `"3m"` |
| `y` | Years (calendar-based, checked yearly) | `"1y"` |

The unit determines the check frequency:
- `"90d"` = rolling 90 days, checked daily at 1 AM
- `"3m"` = calendar-based 3 months, checked on 1st of month at 1 AM

### Constraint Hierarchy

The following constraints are enforced at logger creation:

```
retention.period >= archive.frequency >= file.rotationFrequency
```

**Examples:**

✅ Valid configurations:
- `file.rotationFrequency: "hourly"` + `archive.frequency: "daily"` + `retention.period: "7d"`
- `file.rotationFrequency: "daily"` + `archive.frequency: "monthly"` + `retention.period: "100d"`

❌ Invalid configurations:
- `file.rotationFrequency: "daily"` + `archive.frequency: "hourly"` (can't archive incomplete days)
- `archive.frequency: "monthly"` + `retention.period: "1w"` (1 week < 1 month)
- `file.rotationFrequency: "daily"` + `retention.period: "12h"` (can't delete mid-day)

### Default pino-pretty Options

```typescript
{
  singleLine: process.env.NODE_ENV !== "development",
  colorize: true,
  ignore: "pid,hostname",
  translateTime: "yyyy-mm-dd HH:MM:ss.l",
}
```

### Custom Pino Options (`pinoOptions`)

You can pass any [Pino logger options](https://github.com/pinojs/pino/blob/master/docs/api.md#options) except `transport` (which is managed internally). User-provided options are merged with defaults, with user options taking precedence.

```typescript
import { createLogger, type CustomPinoOptions } from "pino-api-logger";

const pinoOptions: CustomPinoOptions = {
  // Add properties to every log entry
  base: { service: "user-api", version: "2.1.0", env: process.env.NODE_ENV },
  
  // Change the message key from 'msg' to 'message'
  messageKey: "message",
  
  // Add custom log levels
  customLevels: { http: 35, verbose: 15 },
  
  // Custom formatters (merged with defaults)
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
  
  // Custom timestamp format
  timestamp: () => `,"timestamp":${Date.now()}`,
  
  // Redact sensitive fields
  redact: ["password", "token", "req.headers.authorization"],
};

const logger = createLogger({ pinoOptions });
```

**Default Pino options (applied if not overridden):**

```typescript
{
  level: "info",
  base: {},
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  formatters: {
    log: (object) => { /* puts msg last */ },
    level: (label) => ({ level: label }),
  },
}
```

**Note:** The `formatters` object is shallow-merged, so you can override `level` or `log` as desired.

## API

### `createLogger(options?)`

Creates a Pino logger with file writing, archiving, and retention support.

```typescript
const logger = createLogger({
  logDir: "my-logs",
  level: "debug",
});
```

Returns a Pino logger with additional methods:

- **`logger.stopArchiver()`** — Stops the archiver cron job
- **`logger.startArchiver()`** — Starts the archiver (useful when `archive.disabled: true` was set)
- **`logger.stopRetention()`** — Stops the retention cron job
- **`logger.startRetention()`** — Starts the retention scheduler
- **`logger.runArchiver()`** — Runs the archiver immediately (async, returns when complete)
- **`logger.runRetention()`** — Runs retention cleanup immediately (async, returns when complete)
- **`logger.close()`** — Flushes the buffer and closes the file writer stream (async)
- **`logger.getParams()`** — Returns the resolved logger configuration
- **`logger.isCoordinator()`** — Returns `true` if this logger instance is the coordinator (handles archiving/retention in cluster mode)

### `cleanupLogRegistry()`

Cleans up the internal registry by closing all file writers and stopping all archivers and retention schedulers. Useful for testing. Note: this does NOT re-initialize - you'll need to create new loggers after calling this.

```typescript
import { cleanupLogRegistry } from "pino-api-logger";

afterEach(async () => {
  await cleanupLogRegistry();
});
```

### `startArchiver(options)`

Manually start an archiver. Typically not needed as `createLogger` handles this automatically.

### `getOrCreateFileWriter(options)`

Get or create a file writer for a specific log directory. Uses singleton pattern to ensure one writer per directory.

## Log File Structure

### Daily Rotation (default)

```
logs/
├── 2025-01-01.log              # Daily log file
├── 2025-01-01~15-59-59.log     # Overflow file (when max size exceeded)
├── 2025-01-01~15-59-59~123.log # Overflow with milliseconds (rare, high-throughput)
├── 2025-01-02.log              # Today's log file
└── archives/
    ├── 2024-12-archive.tar.gz    # Monthly archive
    └── 2024-11-archive.tar.gz
```

### Hourly Rotation

```
logs/
├── 2025-01-01~00.log           # Hourly log file (midnight hour)
├── 2025-01-01~01.log           # Hourly log file (1 AM hour)
├── 2025-01-01~15-30-00.log     # Overflow file (when max size exceeded)
├── 2025-01-01~15-30-00~456.log # Overflow with milliseconds (rare)
└── archives/
    ├── 2025-01-01-archive.tar.gz  # Daily archive (when archive.frequency: "daily")
    └── 2024-12-archive.tar.gz     # Monthly archive
```

### Overflow File Naming

When a log file exceeds `maxLogSizeMegabytes`, an overflow file is created:

| Situation | Filename Pattern | Example |
|-----------|------------------|---------|
| Normal overflow | `YYYY-MM-DD~HH-mm-ss.log` | `2025-01-01~15-30-00.log` |
| Same-second collision | `YYYY-MM-DD~HH-mm-ss~mmm.log` | `2025-01-01~15-30-00~456.log` |
| Extremely rare collision | `YYYY-MM-DD~HH-mm-ss~mmm~N.log` | `2025-01-01~15-30-00~456~1.log` |

The `~` delimiter ensures files sort chronologically (ASCII `~` > `.`).

### Archive Naming Convention

| archive.frequency | Archive Name Format |
|-------------------|---------------------|
| `"hourly"` | `YYYY-MM-DD~HH-archive.tar.gz` |
| `"daily"` | `YYYY-MM-DD-archive.tar.gz` |
| `"weekly"` | `YYYY-MM-DD-archive.tar.gz` (Monday date) |
| `"monthly"` | `YYYY-MM-archive.tar.gz` |

### Log Format

Logs are written as JSON lines (NDJSON) for easy parsing:

```json
{"level":"info","time":"2025-01-01T10:30:00.000Z","name":"my-app","msg":"User logged in"}
{"level":"error","time":"2025-01-01T10:30:01.000Z","err":{"message":"Connection failed"},"msg":"Database error"}
```

## Usage Examples

### Basic API Logging

```typescript
import { createLogger } from "pino-api-logger";

const logger = createLogger({ logDir: "api-logs" });

// Log request info
app.use((req, res, next) => {
  logger.info({
    method: req.method,
    path: req.path,
    ip: req.ip,
  }, "Incoming request");
  next();
});
```

### With Hono

```typescript
import { Hono } from "hono";
import { createLogger } from "pino-api-logger";

const app = new Hono();
const logger = createLogger();

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
  }, "Request completed");
});
```

### Hourly Rotation with Daily Archiving

```typescript
const logger = createLogger({
  file: { rotationFrequency: "hourly" },
  archive: { frequency: "daily" },
  retention: { period: "7d" },
});
```

### High-Volume Logging with Retention

```typescript
const logger = createLogger({
  file: {
    rotationFrequency: "hourly",
  },
  archive: { frequency: "hourly" },
  retention: { period: "24h" },  // Only keep last 24 hours of logs
});
```

### Child Loggers

```typescript
const logger = createLogger();

// Create a child logger with additional context
const userLogger = logger.child({ service: "user-service" });
userLogger.info({ userId: 123 }, "User created");

// Note that the child logger does not have the new properties of the parent like:
// - getting the params
// - stop/start the archive/retention
// - runArchiver/runRetention
// - ...

// Logs: {"level":"info","service":"user-service","userId":123,"msg":"User created"}
```

### Graceful Shutdown

```typescript
const logger = createLogger();

process.on("SIGTERM", async () => {
  logger.info("Shutting down gracefully");
  logger.stopArchiver();
  logger.stopRetention();
  await logger.close();
  process.exit(0);
});
```

### Manual Archive/Retention Execution

```typescript
const logger = createLogger({
  archive: { runOnCreation: false },  // Don't run on startup
});

// Run archiver manually (e.g., from a custom schedule or admin endpoint)
await logger.runArchiver();

// Run retention cleanup manually
await logger.runRetention();
```

### Disable Archiving / Manual Control

```typescript
// Create logger with archiving disabled but retention enabled
const logger = createLogger({ 
  archive: { disabled: true },
  retention: { period: "7d" },  // Still deletes old logs
});

// Start archiving later when needed
logger.startArchiver();

// Stop and restart archiving as needed
logger.stopArchiver();
logger.startArchiver();
```

### Console-Only Logging

For development or debugging scenarios where you don't need file output:

```typescript
// Console-only logger (no file output, archiving/retention automatically disabled)
const devLogger = createLogger({
  file: { enabled: false },
  console: { enabled: true },
});

// File-only logger (no console output, useful for production)
const prodLogger = createLogger({
  file: { enabled: true },
  console: { enabled: false },
});
```

**Note:** When `file.enabled` is `false`, archiving and retention are automatically disabled since there's nothing to archive or retain. At least one of `file.enabled` or `console.enabled` must be `true` - We will enforce `file.enabled` to be `true` at runtime otherwise.

### Multiple Loggers, Same Directory

When creating multiple loggers pointing to the same directory, the file writer is shared with the strictest settings applied:

```typescript
const apiLogger = createLogger({ 
  logDir: "logs", 
  file: {
    maxBufferLines: 100,
    rotationFrequency: "daily",
  },
});

const dbLogger = createLogger({ 
  logDir: "logs", 
  file: {
    maxBufferLines: 50,           // Stricter - will be used
    rotationFrequency: "hourly",  // Stricter - will be used
  },
});

// Both loggers write to the same file with maxBufferLines: 50 and hourly rotation
```

### Separate Logs by Service/Component

If you need separate log files for different services or components, use subdirectories since this library does not provide a file prefix. This keeps logs isolated:

```ts
// Each service gets its own log directory/files and options:
const apiLogger = createLogger({ logDir: "logs/api" });
const workerLogger = createLogger({ logDir: "logs/worker" });
const schedulerLogger = createLogger({ logDir: "logs/scheduler" });
```

Results in:
```
logs/
├── api/
│   ├── 2025-01-01.log
│   └── archives/
├── worker/
│   ├── 2025-01-01.log
│   └── archives/
└── scheduler/
    ├── 2025-01-01.log
    └── archives/
```

Each subdirectory maintains its own archiving schedule and file rotation independently.

## Multi-Worker / Cluster Usage

When running in a clustered environment using `node:cluster` (or Bun's cluster support), this logger automatically detects worker processes and adjusts behavior accordingly.

### Auto-Detection Behavior

In cluster mode, coordinator election happens automatically:
- **Primary process** is always the coordinator (if it creates a logger)
- **First worker** to create a logger claims coordinator role via atomic `mkdir` lock
- **All workers** schedule archiver/retention cron jobs, but only the coordinator executes them
- **Automatic takeover** — If the coordinator crashes, another worker automatically becomes coordinator on the next cron run

This ensures exactly one process handles archiving/retention execution, regardless of worker IDs or startup order. The coordinator role is checked at runtime when archive and retention worker runs, allowing seamless failover.

### Coordinator Election

The coordinator is elected using an atomic filesystem operation:

1. **Lock mechanism** — Uses `mkdir` to create a `.coordinator-lock` directory (atomic on most filesystems)
2. **Stale lock detection** — Locks older than 30 seconds are considered stale (crashed process) and removed
3. **Heartbeat** — Coordinator updates the lock's mtime every 10 seconds to prevent stale detection
4. **Metadata** — Lock directory contains `meta.json` with PID, hostname, worker ID, and start timestamp for debugging
5. **Cleanup** — Lock is automatically released on process exit (SIGINT, SIGTERM, uncaughtException)

If the coordinator crashes, the next worker to check `isCoordinator()` will detect the stale lock, remove it, and claim the coordinator role.

### File Coordination Between Workers

All workers write to the same log files. The logger handles this through:

1. **Disk-size checks at flush time** — Each worker checks the actual file size on disk before writing, catching when other workers have filled the file
2. **Shared overflow files** — When rotation is triggered, workers converge on the same overflow file rather than each creating their own
3. **Filesystem-based coordination** — No explicit locking; relies on atomic file operations and size checks

### Example: Cluster Setup

```typescript
import cluster from "node:cluster";
import { createLogger } from "pino-api-logger";

if (cluster.isPrimary) {
  // Primary process: spawn workers
  for (let i = 0; i < 4; i++) {
    cluster.fork();
  }
  
  // Primary can also create a logger for its own logs
  const primaryLogger = createLogger({ logDir: "logs" });
  primaryLogger.info("Primary process started");
  
} else {
  // All workers create loggers; first to claim coordinator role runs archiver/retention
  const logger = createLogger({ logDir: "logs" });
  logger.info({ workerId: cluster.worker?.id }, "Worker started");
  
  // Check if this worker is the coordinator
  if (logger.isCoordinator()) {
    logger.info("This worker is the coordinator (handles archiving/retention)");
  }
  
  // ... handle requests
}
```

### Rotation Locking

When rotation is triggered, the logger uses an atomic `mkdir`-based lock to coordinate between workers:

1. **Lock acquisition** — First worker to rotate acquires a `.rotation-lock` directory
2. **Other workers wait** — Workers needing to rotate poll every 20ms until lock is released (max ~1s wait)
3. **Coordinated switch** — After rotation, all workers converge on the same new file
4. **Stale lock detection** — Locks older than 10s are considered stale (crashed process) and removed automatically

This ensures only one overflow file is created per rotation event, even under high concurrency.

### High-Load Considerations

Under very high load, log files may slightly exceed `maxLogSizeMegabytes` before rotation occurs. This is expected behavior — files typically stay within ~1.2x the configured limit. 

At extremely high throughput in cluster mode, rapid consecutive rotations can occasionally occur, potentially creating multiple overflow files within the same second. This is a rare edge case and doesn't affect log integrity. However, it may cause one or the other overflow log file to fill up before the other. There is no telling which will be picked up as the faster to perform rotation will be picked up by the other workers.

For extremely high-throughput workloads, consider:
- Increasing `maxLogSizeMegabytes` (e.g., 200-500MB) to reduce rotation frequency
- Using a centralized logging service (e.g., Datadog, Elasticsearch, CloudWatch)
- Implementing a dedicated log aggregation layer

### Worker Path Resolution

**Note:** Worker path resolution is currently in the works and can be tricky when bundling your app. The logger uses worker threads (`archiver-worker.js` and `retention-worker.js`) for archiving and retention operations. When using bundlers (e.g., webpack, esbuild, rollup), the worker file paths may not resolve correctly due to how bundlers restructure the codebase. If you encounter issues with worker path resolution in a bundled environment, you may need to configure your bundler to properly handle worker thread imports or exclude these worker files from bundling.

## Performance

Based on our own benchmarks, the default file writer options (`file.flushInterval`, `file.maxBufferLines`, `file.maxBufferKilobytes`, `file.maxLogSizeMegabytes`) provide good performance overall for a normal size load and normal size usage. 
The default configuration provides a good balance of performance while maintaining reliable log persistence.

Our benchmarks make use of `autocannon` to push the system to its limits.

You can run your own benchmarks for this by cloning the repository and running:
```bash
bun run benchmark
```
This is for single threaded (Hono like server).

To also include console with pino-pretty
```bash
bun run benchmark:with-console
```
To run the benchmark using all the CPU cores avaibles in multi-threaded mode:
```bash
bun run benchmark:multi-core
```
To run the benchmark multi-threaded and with console:
```bash
bun run benchmark:multi-core-console
```
This benchmark is also not 100% reliable but from our observations it performs correctly and pretty much similarly when compared to the native pino/file transport while providing extra options.

## License

MIT © DiiiaToTe

## Note from the author

This README file was generated by ai based on the files found in the repository.
