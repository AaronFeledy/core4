import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { DataChecksumMismatchError } from "@lando/sdk/errors";
import { runImport } from "../src/actions.ts";
import { withHostDumpCompression, writeDumpTransform } from "../src/compression.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

describe("host dump compression safety", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-dump-safety-"));
  });
  afterEach(async () => {
    cleanupSqlTestDeps();
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
        direction: "export",
        transfer: (path) =>
          Effect.promise(async () => {
            staged = path;
            await writeFile(path, "select 1;");
          }),
      }),
    );
    // Then
    expect(relative(root, staged).startsWith("..")).toBe(false);
    expect(await readdir(root)).toEqual(["dump.sql.gz"]);
  });

  test.skipIf(process.platform === "win32")(
    "protects plaintext import staging from other users",
    async () => {
      // Given
      const source = join(root, "source.gz");
      await writeFile(source, Bun.gzipSync("private dump"));
      let mode = 0;
      // When
      await Effect.runPromise(
        withHostDumpCompression({
          path: source,
          compression: "gzip",
          direction: "import",
          transfer: (path) =>
            Effect.promise(async () => {
              mode = (await stat(path)).mode & 0o777;
            }),
        }),
      );
      // Then
      expect(mode).toBe(0o600);
    },
  );

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

  test("rejects a compressed dump changed after confirmation before transferring it", async () => {
    // Given
    const source = join(root, "changed.gz");
    const original = Bun.gzipSync("approved SQL");
    const expectedDigest = new Bun.CryptoHasher("sha256").update(original).digest("hex");
    await writeFile(source, Bun.gzipSync("replacement SQL"));
    const harness = makeSqlTestDeps({ password: "test-password" });
    let transferred = false;
    const input = {
      plan: harness.deps.plan,
      service: "database",
      family: "mysql" as const,
      creds: { user: "lando", database: "sql-app", password: "test-password" },
      env: {},
      file: source,
      compression: "gzip" as const,
      expectedDigest,
    };
    // When
    const failure = await Effect.runPromise(
      runImport(
        {
          ...harness.deps,
          transfer: () =>
            Effect.sync(() => {
              transferred = true;
              return { accelerated: false };
            }),
        },
        harness.deps.exec,
        input,
      ).pipe(Effect.flip),
    );
    // Then
    expect(failure).toBeInstanceOf(DataChecksumMismatchError);
    expect(transferred).toBe(false);
  });
});
