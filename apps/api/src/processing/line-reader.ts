import type { Readable } from "node:stream";

export interface StreamedLine {
  text: string | null;
  byteLength: number;
  oversized: boolean;
}

export async function* readLines(
  stream: Readable,
  maximumLineBytes: number
): AsyncGenerator<StreamedLine> {
  let pending = Buffer.alloc(0);
  let currentLineBytes = 0;
  let oversized = false;

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let start = 0;

    while (start < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, start);
      const end = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.subarray(start, end);
      currentLineBytes += segment.length;

      if (!oversized) {
        if (currentLineBytes > maximumLineBytes) {
          oversized = true;
          pending = Buffer.alloc(0);
        } else if (segment.length > 0) {
          pending = pending.length === 0 ? segment : Buffer.concat([pending, segment]);
        }
      }

      if (newlineIndex === -1) break;

      const includesCarriageReturn = !oversized && pending.at(-1) === 0x0d;
      const line = includesCarriageReturn ? pending.subarray(0, -1) : pending;
      yield {
        text: oversized ? null : line.toString("utf8"),
        byteLength: currentLineBytes + 1,
        oversized
      };
      pending = Buffer.alloc(0);
      currentLineBytes = 0;
      oversized = false;
      start = newlineIndex + 1;
    }
  }

  if (currentLineBytes > 0 || pending.length > 0 || oversized) {
    const includesCarriageReturn = !oversized && pending.at(-1) === 0x0d;
    const line = includesCarriageReturn ? pending.subarray(0, -1) : pending;
    yield {
      text: oversized ? null : line.toString("utf8"),
      byteLength: currentLineBytes,
      oversized
    };
  }
}
