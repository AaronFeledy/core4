import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { withHostDumpCompression, writeDumpTransform } from "../src/compression.ts";

describe("host dump compression safety", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-dump-safety-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("keeps export staging inside the destination root", async () => {
    // Given
    const destination = join(root, "dump.sql.gz");
    let staged = "";
    // When
    await Effect.runPromise(
      withHostDumpCompression({
        path: destination,
        compression: "gzip",
        transfer: (path) =>
          Effect.promise(async () => {
            staged = path;
            await writeFile(path, "select 1;");
            return { accelerated: false };
          }),
      }),
    );
    // Then
    expect(relative(root, staged).startsWith("..")).toBe(false);
    expect(await readdir(root)).toEqual(["dump.sql.gz"]);
  });

  test("preserves the destination when decompression fails", async () => {
    // Given
    const source = join(root, "broken.gz");
    const destination = join(root, "existing.sql");
    await writeFile(source, Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]));
    await writeFile(destination, "previous dump");
    // When
    await Effect.runPromise(writeDumpTransform(source, destination, "gzip", "decompress").pipe(Effect.exit));
    // Then
    expect(await readFile(destination, "utf8")).toBe("previous dump");
    expect((await readdir(dirname(destination))).sort()).toEqual(["broken.gz", "existing.sql"]);
  });
});
