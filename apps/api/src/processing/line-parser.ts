export interface ParsedLogLine {
  timestamp: Date | null;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  source: string | null;
  attributes: Record<string, unknown>;
  malformed: boolean;
}

const levelMap: Record<string, ParsedLogLine["level"]> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  WARNING: "warn",
  ERROR: "error",
  FATAL: "fatal",
  CRITICAL: "fatal"
};

function normalizedTimestamp(value: unknown): { timestamp: Date | null; malformed: boolean } {
  if (value === undefined || value === null || value === "") {
    return { timestamp: null, malformed: false };
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return { timestamp: null, malformed: true };
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? { timestamp: null, malformed: true }
    : { timestamp, malformed: false };
}

function normalizedLevel(value: unknown, attributes: Record<string, unknown>) {
  if (typeof value !== "string") return "info" as const;
  const upper = value.trim().toUpperCase();
  const mapped = levelMap[upper];
  if (mapped) return mapped;
  if (upper) attributes.unrecognizedSeverity = value;
  return "info" as const;
}

const aliases: Record<string, string> = {
  "@timestamp": "timestamp",
  time: "timestamp",
  ts: "timestamp",
  severity: "level",
  msg: "message",
  service_name: "service",
  requestId: "request_id",
  status_code: "status",
  statusCode: "status",
  latencyMs: "latency_ms",
  latency: "latency_ms"
};
const recognized = new Set([
  "timestamp", "level", "message", "service", "request_id", "status", "latency_ms"
]);

function normalizeObject(record: Record<string, unknown>, rawLine: string): ParsedLogLine {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    values[aliases[key] ?? key] = value;
  }

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!recognized.has(key)) attributes[key] = value;
    else if (["request_id", "status", "latency_ms"].includes(key)) attributes[key] = value;
  }
  const time = normalizedTimestamp(values.timestamp);
  if (time.malformed) attributes.invalidTimestamp = values.timestamp;

  return {
    timestamp: time.timestamp,
    level: normalizedLevel(values.level, attributes),
    message:
      typeof values.message === "string"
        ? values.message
        : values.message === undefined
          ? rawLine
          : JSON.stringify(values.message),
    source: typeof values.service === "string" ? values.service : null,
    attributes,
    malformed: time.malformed
  };
}

function decodeToken(value: string | undefined, quote: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (quote === "'") return value.replace(/\\(['\\])/g, "$1");
  if (quote === '"') {
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      return value;
    }
  }
  return value;
}

function parseKeyValues(text: string): Record<string, string> | null {
  const output: Record<string, string> = {};
  let offset = 0;
  const token = /([A-Za-z_@][\w.@-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+))/y;
  while (offset < text.length) {
    while (/\s/.test(text[offset] ?? "")) offset += 1;
    if (offset >= text.length) break;
    token.lastIndex = offset;
    const match = token.exec(text);
    if (!match) return null;
    const quote = text[offset + match[1].length + 1];
    output[match[1]] = decodeToken(match[2] ?? match[3] ?? match[4], quote) ?? "";
    offset = token.lastIndex;
  }
  return Object.keys(output).length ? output : null;
}

function valueFromText(value: string): unknown {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function parseLogLine(line: string): ParsedLogLine {
  const prefix = /^(\S+)(?:\s+|$)/.exec(line);
  const hasTimestampPrefix =
    prefix !== null && /^\d{4}-\d{2}-\d{2}T/.test(prefix[1]);
  const timeValue = hasTimestampPrefix ? prefix[1] : undefined;
  const remaining = hasTimestampPrefix ? line.slice(prefix[0].length) : line;
  const pairs = parseKeyValues(remaining);

  if (!pairs) {
    const time = normalizedTimestamp(timeValue);
    return {
      timestamp: time.timestamp,
      level: "info",
      message: line,
      source: null,
      attributes: time.malformed ? { invalidTimestamp: timeValue } : {},
      malformed: time.malformed
    };
  }

  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(pairs).map(([key, value]) => [key, valueFromText(value)])
  );
  if (timeValue !== undefined) record.timestamp = timeValue;
  return normalizeObject(record, line);
}

export function parseJsonLine(line: string): ParsedLogLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return normalizeObject(value as Record<string, unknown>, line);
}
