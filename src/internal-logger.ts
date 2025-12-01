import pino from "pino";
import { FileWriter } from "./file-writer";
import type { BaseLoggerOptions, FileWriterOptions } from "./types";

/** Internal function to create a logger */
export function internalCreateLogger({
  logDir,
  level,
  pinoPretty,
  toConsole,
  flushInterval,
  maxBufferLines,
  maxBufferKilobytes,
  maxDailyLogSizeMegabytes,
}: Required<BaseLoggerOptions & FileWriterOptions>) {
  // daily rotating file writer (object with write)
  const fileWriter = new FileWriter({
    logDir,
    flushInterval,
    maxBufferLines,
    maxBufferKilobytes,
    maxDailyLogSizeMegabytes,
  });

  // Build streams array for pino.multistream
  const streams: Array<{ stream: { write: (msg: string) => void } }> = [
    // always write JSON lines to daily file
    { stream: { write: (msg: string) => fileWriter.write(msg) } },
  ];

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

  // Create the pino logger using multistream
  const logger = pino(
    {
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
    },
    pino.multistream(streams),
  );

  return logger;
}
