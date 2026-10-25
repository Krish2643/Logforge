import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseJsonLine, parseLogLine } from "../src/processing/line-parser.js";
import { readLines } from "../src/processing/line-reader.js";

describe("log line parsing", () => {
  it("normalizes key-value log lines while preserving extra attributes", () => {
    const parsed = parseLogLine(
      '2026-10-22T15:11:28.860Z level=ERROR message="request failed" service=api request_id=abc retries=2'
    );

    expect(parsed).toMatchObject({
      timestamp: new Date("2026-10-22T15:11:28.860Z"),
      level: "error",
      message: "request failed",
      source: "api",
      attributes: { request_id: "abc", retries: 2 },
      malformed: false
    });
  });

  it("normalizes JSON records and leaves absent timestamps unset", () => {
    expect(parseJsonLine('{"severity":"warning","msg":"slow","latencyMs":42}')).toMatchObject({
      timestamp: null,
      level: "warn",
      message: "slow",
      attributes: { latency_ms: 42 },
      malformed: false
    });
    expect(parseJsonLine("{not-json")).toBeNull();
    expect(parseJsonLine("[]")).toBeNull();
  });

  it("counts invalid timestamps without substituting a current timestamp", () => {
    const parsed = parseJsonLine('{"timestamp":"not-a-date","message":"event"}');
    expect(parsed).toMatchObject({
      timestamp: null,
      malformed: true,
      attributes: { invalidTimestamp: "not-a-date" }
    });
  });
});

describe("bounded line reader", () => {
  it("handles chunk boundaries, CRLF, final lines, and oversized lines", async () => {
    const stream = Readable.from([
      Buffer.from("one\r\n"),
      Buffer.from("oversized"),
      Buffer.from(" line\nlast")
    ]);
    const lines = [];
    for await (const line of readLines(stream, 8)) lines.push(line);

    expect(lines).toEqual([
      { text: "one", byteLength: 5, oversized: false },
      { text: null, byteLength: 15, oversized: true },
      { text: "last", byteLength: 4, oversized: false }
    ]);
  });
});
