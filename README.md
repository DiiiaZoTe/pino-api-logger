# pino-api-logger

A self-hosted, server-side API logger built on top of [Pino](https://github.com/pinojs/pino) with multi-stream writing, daily rotation, buffered writes, and monthly archiving. Designed for Node.js and Bun projects.

## Features

- 🚀 **High Performance** — Built on Pino, one of the fastest Node.js loggers
- 📁 **Daily Log Rotation** — Automatically rotates logs at midnight
- 📦 **Buffered Writes** — Configurable buffer size and flush interval for optimized I/O
- 🗜️ **Monthly Archiving** — Automatically compresses old logs into `.tar.gz` archives
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
- Multi-stream setup: file + optional console (this is core and canoot be removed)

**Managed internally (cannot be overridden):**
- Transport configuration (multi-stream to file + console)
- Daily rotation and buffered writes
- Monthly archiving

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

  // File writer options
  flushInterval: 200,             // Buffer flush interval in ms (default: 200, min: 20)
  maxBufferLines: 500,            // Max lines to buffer before flush (default: 500, min: 1)
  maxBufferKilobytes: 1024,       // Max KB to buffer before flush (default: 1024)
  maxDailyLogSizeMegabytes: 100,  // Max log file size before rotation (default: 100MB)

  // Monthly archiver options
  archiveCron: "0 1 1 * *",       // Cron schedule for archiving, if any needed (default: 1st of month at 01:00)
  runArchiveOnCreation: true,     // Run archive check on logger creation (default: true)
  archiveDir: "archives",         // Archive directory relative to logDir (default: "archives")
  archiveLogging: true,           // Log archive operations (default: true)
});
```

### Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logDir` | `string` | `"logs"` | Directory for log files |
| `level` | `string` | `"info"` | Pino default log level |
| `toConsole` | `boolean` | `true` | Enable console output via pino-pretty (False recommended in Production if you don't have a need to drain logs) |
| `pinoPretty` | `PrettyOptions` | See below | pino-pretty configuration |
| `pinoOptions` | `CustomPinoOptions` | `undefined` | Custom Pino options to override defaults (see below) |
| `flushInterval` | `number` | `200` | Buffer flush interval (ms) |
| `maxBufferLines` | `number` | `500` | Max buffered lines before flush |
| `maxBufferKilobytes` | `number` | `1024` | Max buffered KB before flush |
| `maxDailyLogSizeMegabytes` | `number` | `100` | Max file size before rotation |
| `archiveCron` | `string` | `"0 1 1 * *"` | Cron expression for archiving. Check + run archive if any needed |
| `runArchiveOnCreation` | `boolean` | `true` | Archive needed files immediately on startup |
| `archiveDir` | `string` | `"archives"` | Archive output directory |
| `archiveLogging` | `boolean` | `true` | Log archiver operations |

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

Creates a Pino logger with file writing and monthly archiving.

```typescript
const logger = createLogger({
  logDir: "my-logs",
  level: "debug",
});
```

Returns a Pino logger with additional methods:

- **`logger.stopArchiver()`** — Stops the monthly archiver cron job
- **`logger.close()`** — Flushes the buffer and closes the file writer stream (async)
- **`logger.getParams()`** — Returns the resolved logger configuration

### `resetLogRegistry()`

Resets the internal registry by closing all file writers and stopping all archivers. Useful for testing.

```typescript
import { resetLogRegistry } from "pino-api-logger";

afterEach(async () => {
  await resetLogRegistry();
});
```

### `startMonthlyArchiver(options)`

Manually start a monthly archiver. Typically not needed as `createLogger` handles this automatically.

### `getOrCreateFileWriter(options)`

Get or create a file writer for a specific log directory. Uses singleton pattern to ensure one writer per directory.

### `getOrCreateArchiver(options)`

Get or create an archiver for a specific log directory. Throws if conflicting options are provided for the same directory.

## Log File Structure

```
logs/
├── 2024-01-15.log           # Today's log file
├── 2024-01-14.log           # Yesterday's log
├── 2024-01-14.23-59-59.log  # Overflow file (when max size exceeded)
└── archives/
    ├── 2023-12.tar.gz       # Archived December logs
    └── 2023-11.tar.gz       # Archived November logs
```

### Log Format

Logs are written as JSON lines (NDJSON) for easy parsing:

```json
{"level":"info","time":"2024-01-15T10:30:00.000Z","name":"my-app","msg":"User logged in"}
{"level":"error","time":"2024-01-15T10:30:01.000Z","err":{"message":"Connection failed"},"msg":"Database error"}
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

### Child Loggers

```typescript
const logger = createLogger();

// Create a child logger with additional context
const userLogger = logger.child({ service: "user-service" });
userLogger.info({ userId: 123 }, "User created");

// Logs: {"level":"info","service":"user-service","userId":123,"msg":"User created"}
```

### Graceful Shutdown

```typescript
const logger = createLogger();

process.on("SIGTERM", () => {
  logger.info("Shutting down gracefully");
  logger.stopArchiver();
  logger.close()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Failed to close logger", err);
      process.exit(1);
    });
});
```

### Multiple Loggers, Same Directory

When creating multiple loggers pointing to the same directory, the file writer is shared with the strictest settings applied:

```typescript
const apiLogger = createLogger({ 
  logDir: "logs", 
  maxBufferLines: 100 
});

const dbLogger = createLogger({ 
  logDir: "logs", 
  maxBufferLines: 50  // This stricter setting will be used
});

// Both loggers write to the same file with maxBufferLines: 50
```

## Performance

Based on our own benchmarks, the default file writer options (`flushInterval`, `maxBufferLines`, `maxBufferKilobytes`, `maxDailyLogSizeMegabytes`) provide the best performance overall for a normal size load and normal size usage. 
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