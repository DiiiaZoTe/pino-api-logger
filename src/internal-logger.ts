import pino from "pino";
import { getOrCreateFileWriter } from "./registry";
import type { BaseLoggerOptions, CustomPinoOptions, FileWriterOptions } from "./types";

/** Internal function to create a logger */
export function internalCreateLogger({
  logDir,
  level,
  pinoPretty,
  toConsole,
  toFile,
  pinoOptions,
  flushInterval,
  maxBufferLines,
  maxBufferKilobytes,
  maxDailyLogSizeMegabytes,
}: Required<Omit<BaseLoggerOptions, "pinoOptions"> & FileWriterOptions> & {
  pinoOptions?: CustomPinoOptions;
}) {
  // daily rotating file writer (object with write)
  // Use registry to ensure singleton writer per directory (only if writing to file)
  const fileWriter = toFile
    ? getOrCreateFileWriter({
        logDir,
        flushInterval,
        maxBufferLines,
        maxBufferKilobytes,
        maxDailyLogSizeMegabytes,
      })
    : null;

  // Build streams array for pino.multistream
  const streams: Array<{ stream: { write: (msg: string) => void } }> = [];

  // Add file stream when toFile is enabled
  if (toFile && fileWriter) {
    streams.push({ stream: { write: (msg: string) => fileWriter.write(msg) } });
  }

  // stdout when requested
  if (toConsole) {
    // force singleLine if not in development (helps with production logs)
    if (pinoPretty) {
      pinoPretty.singleLine = !(
        process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
      );
    }
    // lazy import pino-pretty so it is not required in prod/dev builds that don't need it
    const { PinoPretty } = require("pino-pretty");
    const prettyStream = PinoPretty(pinoPretty);

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
      ...mergedOptions,
      ...(fileWriter?.getInstanceOptions() ?? {}),
    }),
    close: async () => {
      if (fileWriter) {
        await fileWriter.close();
      }
    },
  };
}
