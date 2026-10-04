import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";

import { pastDeadline, systemProcWalk } from "../src/proc-walk.ts";

test.each(["text", "names", "link"] as const)(
  "%s returns undefined when the path is absent",
  async (method) => {
    // Given: a unique path that has never been created.
    const path = `/tmp/lando-proc-walk-${crypto.randomUUID()}/missing`;
    // When
    const result = await systemProcWalk[method](path);
    // Then
    expect(result).toBeUndefined();
  },
);

test("text rethrows when Bun throws a non-Error value", async () => {
  // Given: a host failure outside the ordinary filesystem Error contract.
  const failure = Symbol("host failure");
  const file = spyOn(Bun, "file").mockImplementation(() => {
    throw failure;
  });
  try {
    // When
    const result = systemProcWalk.text("/unused");
    // Then
    await expect(result).rejects.toBe(failure);
  } finally {
    file.mockRestore();
  }
});

test.each([
  ["names", "readdir"],
  ["link", "readlink"],
] as const)("%s rethrows when filesystem IO rejects with a non-Error value", async (method, operation) => {
  // Given: a host rejection outside the ordinary filesystem Error contract.
  const failure = Symbol("host failure");
  const io = spyOn(fs, operation).mockRejectedValue(failure);
  try {
    // When
    const result = systemProcWalk[method]("/unused");
    // Then
    await expect(result).rejects.toBe(failure);
  } finally {
    io.mockRestore();
  }
});

test.each([
  [99, false],
  [100, true],
  [101, true],
] as const)("deadline comparison at %i respects the inclusive boundary", (now, expected) => {
  // Given: an injected clock and a fixed deadline.
  const walk = { ...systemProcWalk, now: () => now };
  // When
  const expired = pastDeadline(walk, 100);
  // Then
  expect(expired).toBe(expected);
});
