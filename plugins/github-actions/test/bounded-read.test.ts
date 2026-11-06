import { expect, it } from "bun:test";
import { Effect } from "effect";
import { readBounded } from "../src/bounded-read.ts";
import { limits } from "../src/diagnostics.ts";

it("stops requesting bytes at the file cap when a reader keeps producing data", async () => {
  let consumed = 0;
  const result = await Effect.runPromise(
    readBounded(
      {
        size: limits.fileBytes,
        read: async (buffer) => {
          consumed += buffer.length;
          buffer.fill(120);
          return buffer.length;
        },
      },
      limits.aggregateBytes,
    ),
  );
  expect(result.bytes).toBe(limits.fileBytes);
  expect(consumed).toBe(limits.fileBytes);
});

it("charges partial reads when the following read fails", async () => {
  let reads = 0;
  const result = await Effect.runPromise(
    readBounded(
      {
        size: 20,
        read: async () => {
          if (++reads === 1) return 10;
          throw new TypeError("PRIVATE_SENTINEL");
        },
      },
      limits.aggregateBytes,
    ),
  );
  expect(result).toEqual({ status: "unreadable-file", bytes: 10 });
});

it("never requests a lookahead byte after the remaining aggregate budget", async () => {
  let consumed = 0;
  const result = await Effect.runPromise(
    readBounded(
      {
        size: 20,
        read: async (buffer) => {
          consumed += buffer.length;
          return buffer.length;
        },
      },
      10,
    ),
  );
  expect(result).toEqual({ status: "aggregate-limit", bytes: 10 });
  expect(consumed).toBe(10);
});

it("rejects an oversized opened file before allocating or reading its contents", async () => {
  let read = false;
  const result = await Effect.runPromise(
    readBounded(
      {
        size: limits.fileBytes + 1,
        read: async () => {
          read = true;
          return 0;
        },
      },
      limits.aggregateBytes,
    ),
  );
  expect(result).toEqual({ status: "file-limit", bytes: 0 });
  expect(read).toBe(false);
});

it("rejects invalid UTF-8 without altering bytes into replacement characters", async () => {
  let read = false;
  const result = await Effect.runPromise(
    readBounded(
      {
        size: 1,
        read: async (buffer) => {
          if (read) return 0;
          read = true;
          buffer[0] = 0xff;
          return 1;
        },
      },
      limits.aggregateBytes,
    ),
  );
  expect(result).toEqual({ status: "invalid-encoding", bytes: 1 });
});

it("reports the file budget rather than aggregate exhaustion when a reader grows to the file cap", async () => {
  const result = await Effect.runPromise(
    readBounded(
      {
        size: 1,
        read: async (buffer) => {
          buffer.fill(120);
          return buffer.length;
        },
      },
      limits.aggregateBytes,
    ),
  );
  expect(result).toEqual({ status: "file-limit", bytes: limits.fileBytes });
});
