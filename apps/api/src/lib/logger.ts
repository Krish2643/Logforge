import pino, { type Logger } from "pino";

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "password", "DATABASE_URL"],
      censor: "[REDACTED]"
    }
  });
}
