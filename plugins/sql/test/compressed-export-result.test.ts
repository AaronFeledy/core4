import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { withHostDumpCompression } from "../src/compression.ts";

describe("compressed export artifact metadata", () => {
  for (const compression of ["gzip", "zstd"] as const) {
    test(`reports the written ${compression} artifact size and digest`, async () => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "lando-export-result-"));
      const file = join(root, "dump");
      const payload = "select 1;\n".repeat(1000);
      try {
        // When
        const result = await Effect.runPromise(
          withHostDumpCompression({
            path: file,
            compression,
            direction: "export",
            transfer: (path) =>
              Effect.promise(async () => {
                await writeFile(path, payload);
                return { accelerated: true, sizeBytes: payload.length, digest: "plaintext-digest" };
              }),
          }),
        );

        // Then
        expect(result.sizeBytes).toBe((await stat(file)).size);
        expect(result.digest).toBe(new Bun.CryptoHasher("sha256").update(await readFile(file)).digest("hex"));
        expect(result.accelerated).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
