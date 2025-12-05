import pino from "pino";
import { getOrCreateFileWriter } from "./registry";
import type { ResolvedLoggerOptions } from "./types";

/** Internal function to create a logger */
export function internalCreateLogger(options: ResolvedLoggerOptions) {
  const { logDir, level, pinoOptions, file, console: consoleOpts } = options;

  // Rotating file writer (object with write)
  // Use registry to ensure singleton writer per directory (only if writing to file)
  const fileWriter = file.enabled
    ? getOrCreateFileWriter({
        logDir,
        ...file,
      })
    : null;

  // Build streams array for pino.multistream
  const streams: Array<{ stream: { write: (msg: string) => void } }> = [];

  // Add file stream when file.enabled is true
  if (file.enabled && fileWriter) {
    streams.push({ stream: { write: (msg: string) => fileWriter.write(msg) } });
  }

  // stdout when requested
  if (consoleOpts.enabled) {
    // Create a copy of pretty options to avoid mutating the original
    const prettyOptions = { ...consoleOpts.pretty };
    // force singleLine if not in development (helps with production logs)
    prettyOptions.singleLine = !(
      process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
    );

    // lazy import pino-pretty so it is not required in prod/dev builds that don't need it
    const { PinoPretty } = require("pino-pretty");
    const prettyStream = PinoPretty(prettyOptions);

    // prettyStream is a transform stream that accepts pino JSON and writes pretty output to stdout.
    // Push it as a stream that has a write() method so multistream can use it.
    streams.push({ stream: prettyStream });
  }

  // Default pino options (can be overridden by user's pinoOptions)
  const defaultPinoOptions: pino.LoggerOptions = {
    level,
    base: {},
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      log(object) {
        const { msg, ...rest } = object;
        return { ...rest, msg }; // msg comes last
      },
      level: (label) => ({ level: label }),
    },
  };

  // Merge user's pinoOptions with defaults (user options take precedence)
  // Note: formatters are shallow merged to allow partial overrides
  const mergedOptions: pino.LoggerOptions = {
    ...defaultPinoOptions,
    ...pinoOptions,
    formatters: {
      ...defaultPinoOptions.formatters,
      ...pinoOptions?.formatters,
    },
  };

  // Create the pino logger using multistream
  const logger = pino(mergedOptions, pino.multistream(streams));

  return {
    logger,
    getParams: () => ({
      file: {
        ...file,
        ...(fileWriter?.getInstanceOptions() ?? {}),
      },
    }),
    close: async () => {
      if (fileWriter) {
        await fileWriter.close();
      }
    },
  };
}
