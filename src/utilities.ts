import fs from "node:fs/promises";
import type {
  ArchiveFrequency,
  FileRotationFrequency,
  ParsedRetention,
  RetentionUnit,
} from "./types";

/**
 * Check if a file exists
 * @param filePath - The path to the file
 * @returns True if the file exists, false otherwise
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a retention string (e.g., "7d", "3m", "1y") into its components.
 * @throws Error if the retention string is invalid
 */
export function parseRetention(retention: string): ParsedRetention {
  const match = retention.match(/^(\d+)([hdwmy])$/);
  if (!match) {
    throw new Error(
      `Invalid retention format: "${retention}". Expected format: <number><unit> (e.g., "7d", "3m", "1y")`,
    );
  }
  return {
    value: parseInt(match[1], 10),
    unit: match[2] as RetentionUnit,
  };
}

/**
 * Convert retention to hours for comparison purposes.
 * Uses maximum values to be conservative in constraint validation.
 */
export function retentionToHours(retention: string): number {
  const { value, unit } = parseRetention(retention);
  switch (unit) {
    case "h":
      return value;
    case "d":
      return value * 24;
    case "w":
      return value * 24 * 7;
    case "m":
      return value * 24 * 31; // Max days in a month
    case "y":
      return value * 24 * 366; // Max days in a year (leap year)
  }
}

/**
 * Convert a frequency to hours for comparison purposes.
 * Uses maximum values to be conservative in constraint validation.
 */
export function frequencyToHours(frequency: FileRotationFrequency | ArchiveFrequency): number {
  switch (frequency) {
    case "hourly":
      return 1;
    case "daily":
      return 24;
    case "weekly":
      return 24 * 7;
    case "monthly":
      return 24 * 31; // Max days in a month
  }
}

/**
 * Get the Monday of the week for a given date.
 * Used for weekly archive grouping.
 */
export function getMondayOfWeek(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}


/**
 * Get the archive filename based on period and frequency.
 */
export function getArchiveFilename(period: string): string {
  // Archive naming convention:
  // - Hourly: YYYY-MM-DD~HH-archive.tar.gz
  // - Daily: YYYY-MM-DD-archive.tar.gz
  // - Weekly: YYYY-MM-DD-archive.tar.gz (Monday date)
  // - Monthly: YYYY-MM-archive.tar.gz
  return `${period}-archive.tar.gz`;
}

/**
 * Extract the period from a log filename based on archive frequency.
 * Supports both daily (YYYY-MM-DD.log) and hourly (YYYY-MM-DD~HH.log) log files,
 * as well as overflow files (YYYY-MM-DD~HH-mm-ss.log).
 */
export function getFilePeriod(filename: string, frequency: ArchiveFrequency): string | null {
  // Extract the base name without extension
  const baseName = filename.replace(/\.log$/, "");

  // Try to parse the date from the filename
  // Formats: YYYY-MM-DD, YYYY-MM-DD~HH, YYYY-MM-DD~HH-mm-ss, etc.
  const dateMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;

  const dateStr = dateMatch[1];
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;

  // Extract hour if present (for hourly files)
  const hourMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})~(\d{2})/);

  switch (frequency) {
    case "hourly":
      // For hourly archiving, group by date~hour
      // If file is hourly (YYYY-MM-DD~HH.log), use that
      // If file is overflow (YYYY-MM-DD~HH-mm-ss.log), extract the hour
      if (hourMatch) {
        return `${dateStr}~${hourMatch[2]}`;
      }
      // Daily log file being archived hourly - use date~00 as fallback
      return `${dateStr}~00`;

    case "daily":
      // For daily archiving, group by date
      return dateStr;

    case "weekly":
      // For weekly archiving, group by Monday of the week
      return getMondayOfWeek(date);

    case "monthly":
      // For monthly archiving, group by YYYY-MM
      return dateStr.slice(0, 7);
  }
}

/**
 * Get the current period string that should be skipped (incomplete period).
 */
export function getCurrentPeriod(now: Date, frequency: ArchiveFrequency): string {
  const dateStr = now.toISOString().slice(0, 10);
  const hour = String(now.getHours()).padStart(2, "0");

  switch (frequency) {
    case "hourly":
      return `${dateStr}~${hour}`;
    case "daily":
      return dateStr;
    case "weekly":
      return getMondayOfWeek(now);
    case "monthly":
      return dateStr.slice(0, 7);
  }
}


/**
 * Parse a log filename to extract its date/time period.
 * Supports: YYYY-MM-DD.log, YYYY-MM-DD~HH.log, YYYY-MM-DD~HH-mm-ss*.log
 * Returns the Date representing the start of that period.
 * @param filename - The filename to parse
 * @returns The Date representing the start of that period
 */
export function parseLogFilename(filename: string): Date | null {
  const baseName = filename.replace(/\.log$/, "");

  // Try to match hourly/overflow format: YYYY-MM-DD~HH or YYYY-MM-DD~HH-mm-ss
  const hourlyMatch = baseName.match(/^(\d{4})-(\d{2})-(\d{2})~(\d{2})/);
  if (hourlyMatch) {
    const [, year, month, day, hour] = hourlyMatch;
    return new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
    );
  }

  // Try to match daily format: YYYY-MM-DD
  const dailyMatch = baseName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dailyMatch) {
    const [, year, month, day] = dailyMatch;
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
  }

  return null;
}

/**
 * Parse an archive filename to extract its period.
 * Supports: YYYY-MM-DD~HH-archive.tar.gz, YYYY-MM-DD-archive.tar.gz, YYYY-MM-archive.tar.gz
 * Returns the Date representing the start of that period.
 * @param filename - The filename to parse
 * @returns The Date representing the start of that period
 */
export function parseArchiveFilename(filename: string): Date | null {
  const baseName = filename.replace(/-archive(-\d+)?\.tar\.gz$/, "");

  // Hourly archive: YYYY-MM-DD~HH
  const hourlyMatch = baseName.match(/^(\d{4})-(\d{2})-(\d{2})~(\d{2})$/);
  if (hourlyMatch) {
    const [, year, month, day, hour] = hourlyMatch;
    return new Date(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
    );
  }

  // Daily/Weekly archive: YYYY-MM-DD
  const dailyMatch = baseName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dailyMatch) {
    const [, year, month, day] = dailyMatch;
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
  }

  // Monthly archive: YYYY-MM
  const monthlyMatch = baseName.match(/^(\d{4})-(\d{2})$/);
  if (monthlyMatch) {
    const [, year, month] = monthlyMatch;
    return new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
  }

  return null;
}

/**
 * Calculate the cutoff date based on retention value and unit.
 * @param now - The current date
 * @param value - The retention value
 * @param unit - The retention unit
 * @returns The cutoff date
 */
export function getCutoffDate(now: Date, value: number, unit: RetentionUnit): Date {
  const cutoff = new Date(now);

  switch (unit) {
    case "h":
      cutoff.setHours(cutoff.getHours() - value);
      break;
    case "d":
      cutoff.setDate(cutoff.getDate() - value);
      break;
    case "w":
      cutoff.setDate(cutoff.getDate() - value * 7);
      break;
    case "m":
      cutoff.setMonth(cutoff.getMonth() - value);
      break;
    case "y":
      cutoff.setFullYear(cutoff.getFullYear() - value);
      break;
  }

  return cutoff;
}