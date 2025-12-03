# pino-api-logger

A self-hosted, server-side API logger built on top of [Pino](https://github.com/pinojs/pino) with multi-stream writing, configurable rotation frequencies, buffered writes, flexible archiving, and log retention. Designed for Node.js and Bun projects.

## v2.0 Breaking Changes

Version 2.0 introduces several new features and breaking changes:

- **`archiveCron` removed** — Replaced by `archiveFrequency` which automatically determines the cron schedule
- **`maxDailyLogSizeMegabytes` renamed** — Now called `maxLogSizeMegabytes` (applies per rotation period)
- **New options** — `fileRotationFrequency`, `archiveFrequency`, `logRetention`
- **Constraint validation** — Invalid configuration combinations now throw errors at logger creation

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

## Batteries-Included with Customization

This package provides **sensible defaults** for a production-ready logging setup while allowing you to customize Pino's configuration when needed.

**Defaults (can be overridden via `pinoOptions`):**
- Log format: JSON lines with ISO timestamps
- Formatter structure: `level` as string, `msg` always last
- Base options: `pid` and `hostname` excluded
- Multi-stream setup: file and/or console (at least one must be enabled)

**Managed internally (cannot be overridden):**
- Transport configuration (multi-stream to file + console)
- File rotation and buffered writes (when `toFile: true`)
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
  // Base logger options
  logDir: "logs",           // Directory to write logs (default: "logs")
  level: "info",            // Log level: trace, debug, info, warn, error, fatal (default: "info")
  toFile: true,             // Write to file (default: true)
  toConsole: true,          // Write to console (default: true)
  pinoPretty: {             // pino-pretty options for console output
    singleLine: false,
    colorize: true,
    ignore: "pid,hostname",
    translateTime: "yyyy-mm-dd HH:MM:ss.l",
  },

  // Custom Pino options (optional - override defaults)
  pinoOptions: {
    base: { service: "my-api" },  // Add service info to every log
    messageKey: "message",        // Use 'message' instead of 'msg'
    // ... any other pino.LoggerOptions (except transport)
  },

  // File rotation options
  fileRotationFrequency: "daily",  // "hourly" | "daily" (default: "daily")
  flushInterval: 200,              // Buffer flush interval in ms (default: 200, min: 20)
  maxBufferLines: 500,             // Max lines to buffer before flush (default: 500, min: 1)
  maxBufferKilobytes: 1024,        // Max KB to buffer before flush (default: 1024)
  maxLogSizeMegabytes: 100,        // Max log file size before overflow (default: 100MB)

  // Archiver options
  archiveFrequency: "monthly",     // "hourly" | "daily" | "weekly" | "monthly" (default: "monthly")
  runArchiveOnCreation: true,      // Run archive check on logger creation (default: true)
  archiveDir: "archives",          // Archive directory relative to logDir (default: "archives")
  archiveLogging: true,            // Log archive operations (default: true)
  disableArchiving: false,         // Completely disable archiving (default: false)

  // Retention options
  logRetention: "30d",             // Delete logs/archives older than this (default: undefined)
});
```

### Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logDir` | `string` | `"logs"` | Directory for log files |
| `level` | `string` | `"info"` | Pino default log level |
| `toFile` | `boolean` | `true` | Write logs to file. This is the default if both `toFile` or `toConsole` are set to false |
| `toConsole` | `boolean` | `true` | Enable console output via pino-pretty (False recommended in Production if you don't have a need to drain logs) |
| `pinoPretty` | `PrettyOptions` | See below | pino-pretty configuration |
| `pinoOptions` | `CustomPinoOptions` | `undefined` | Custom Pino options to override defaults |
| `fileRotationFrequency` | `"hourly" \| "daily"` | `"daily"` | How often to rotate log files |
| `flushInterval` | `number` | `200` | Buffer flush interval (ms) |
| `maxBufferLines` | `number` | `500` | Max buffered lines before flush |
| `maxBufferKilobytes` | `number` | `1024` | Max buffered KB before flush |
| `maxLogSizeMegabytes` | `number` | `100` | Max file size before overflow rotation |
| `archiveFrequency` | `"hourly" \| "daily" \| "weekly" \| "monthly"` | `"monthly"` | How often to archive logs |
| `runArchiveOnCreation` | `boolean` | `true` | Archive needed files immediately on startup |
| `archiveDir` | `string` | `"archives"` | Archive output directory |
| `archiveLogging` | `boolean` | `true` | Log archiver operations |
| `disableArchiving` | `boolean` | `false` | Completely disable the archiving process |
| `logRetention` | `string` | `undefined` | Retention period (e.g., "7d", "3m", "1y") |

### Log Retention Format

The `logRetention` option accepts a string in the format `<number><unit>`:

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
logRetention >= archiveFrequency >= fileRotationFrequency
```

**Examples:**

✅ Valid configurations:
- `fileRotationFrequency: "hourly"` + `archiveFrequency: "daily"` + `logRetention: "7d"`
- `fileRotationFrequency: "daily"` + `archiveFrequency: "monthly"` + `logRetention: "100d"`

❌ Invalid configurations:
- `fileRotationFrequency: "daily"` + `archiveFrequency: "hourly"` (can't archive incomplete days)
- `archiveFrequency: "monthly"` + `logRetention: "1w"` (1 week < 1 month)
- `fileRotationFrequency: "daily"` + `logRetention: "12h"` (can't delete mid-day)

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
- **`logger.startArchiver()`** — Starts the archiver (useful when `disableArchiving: true` was set)
- **`logger.stopRetention()`** — Stops the retention cron job
- **`logger.startRetention()`** — Starts the retention scheduler
- **`logger.close()`** — Flushes the buffer and closes the file writer stream (async)
- **`logger.getParams()`** — Returns the resolved logger configuration

### `resetLogRegistry()`

Resets the internal registry by closing all file writers and stopping all archivers and retention schedulers. Useful for testing.

```typescript
import { resetLogRegistry } from "pino-api-logger";

afterEach(async () => {
  await resetLogRegistry();
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
├── 2025-01-01.log           # Daily log file
├── 2025-01-01~15-59-59.log  # Overflow file (when max size exceeded)
├── 2025-01-02.log           # Today's log file
└── archives/
    ├── 2024-12-archive.tar.gz    # Monthly archive
    └── 2024-11-archive.tar.gz
```

### Hourly Rotation

```
logs/
├── 2025-01-01~00.log        # Hourly log file (midnight hour)
├── 2025-01-01~01.log        # Hourly log file (1 AM hour)
├── 2025-01-01~15-30-00.log  # Overflow file (when max size exceeded)
└── archives/
    ├── 2025-01-01-archive.tar.gz  # Daily archive (when archiveFrequency: "daily")
    └── 2024-12-archive.tar.gz     # Monthly archive
```

### Archive Naming Convention

| archiveFrequency | Archive Name Format |
|------------------|---------------------|
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
  fileRotationFrequency: "hourly",  // Rotate logs every hour
  archiveFrequency: "daily",        // Archive accumulated hourly logs daily
  logRetention: "7d",               // Keep logs for 7 days
});
```

### High-Volume Logging with Retention

```typescript
const logger = createLogger({
  fileRotationFrequency: "hourly",
  archiveFrequency: "hourly",
  logRetention: "24h",              // Only keep last 24 hours of logs
  maxLogSizeMegabytes: 50,          // Smaller files for faster processing
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
// - ...

// Logs: {"level":"info","service":"user-service","userId":123,"msg":"User created"}
```

### Graceful Shutdown

```typescript
const logger = createLogger();

process.on("SIGTERM", () => {
  logger.info("Shutting down gracefully");
  logger.stopArchiver();
  logger.stopRetention();
  logger.close()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Failed to close logger", err);
      process.exit(1);
    });
});
```

### Disable Archiving / Manual Control

```typescript
// Create logger with archiving disabled but retention enabled
const logger = createLogger({ 
  disableArchiving: true,
  logRetention: "7d",  // Still deletes old logs
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
  toFile: false,
  toConsole: true,
});

// File-only logger (no console output, useful for production)
const prodLogger = createLogger({
  toFile: true,
  toConsole: false,
});
```

**Note:** When `toFile` is `false`, archiving and retention are automatically disabled since there's nothing to archive or retain. At least one of `toFile` or `toConsole` must be `true` - We will enforce `toFile` to be `true` at compile time otherwise.

### Multiple Loggers, Same Directory

When creating multiple loggers pointing to the same directory, the file writer is shared with the strictest settings applied:

```typescript
const apiLogger = createLogger({ 
  logDir: "logs", 
  maxBufferLines: 100,
  fileRotationFrequency: "daily",
});

const dbLogger = createLogger({ 
  logDir: "logs", 
  maxBufferLines: 50,               // Stricter - will be used
  fileRotationFrequency: "hourly",  // Stricter - will be used
});

// Both loggers write to the same file with maxBufferLines: 50 and hourly rotation
```

### Separate Logs by Service/Component

If you need separate log files for different services or components, use subdirectories since this library does not provide a file prefix. This keeps logs isolated:

```ts
// Each service gets its own log directory and files:
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

## Performance

Based on our own benchmarks, the default file writer options (`flushInterval`, `maxBufferLines`, `maxBufferKilobytes`, `maxLogSizeMegabytes`) provide the best performance overall for a normal size load and normal size usage. 
The default configuration provides a good balance of performance while maintaining reliable log persistence.

You run your own benchmarks for this by cloning the repository and running:
```bash
bun run benchmark
```
or to also include console with pino-pretty
```bash
bun run benchmark:with-console
```
This benchmark is also not 100% reliable but from our observations it does not perform any worse than the native pino/file transport.

## License

MIT © DiiiaToTe

## Note from the author

This README file was generated by ai based on the files found in the repository.
