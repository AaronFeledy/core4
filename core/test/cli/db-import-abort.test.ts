import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { withHostDumpCompression } from "@lando/sql/compression";

import { runCompiledCommand, runWithProcessAbortSignal } from "../../src/cli/compiled-runtime.ts";

const dumpPrefix = ".lando-dump-";

describe("db import abort cleanup", () => {
  let root = "";
  let raw = false;
  const stdin = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => NodeJS.ReadStream;
  };
  let previousSetRaw: typeof stdin.setRawMode;
  let previousIsRaw: PropertyDescriptor | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-import-abort-"));
    raw = false;
    previousSetRaw = stdin.setRawMode;
    previousIsRaw =
      Object.getOwnPropertyDescriptor(stdin, "isRaw") ??
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stdin), "isRaw");
    Object.defineProperty(stdin, "isRaw", {
      configurable: true,
      enumerable: true,
      get: () => raw,
    });
    stdin.setRawMode = ((mode: boolean) => {
      raw = mode;
      return stdin;
    }) as typeof stdin.setRawMode;
  });

  afterEach(async () => {
    if (previousSetRaw === undefined) delete stdin.setRawMode;
    else stdin.setRawMode = previousSetRaw;
    if (previousIsRaw === undefined) delete (stdin as { isRaw?: boolean }).isRaw;
    else Object.defineProperty(stdin, "isRaw", previousIsRaw);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("abort mid db import removes the staged dump and restores stdin raw mode", async () => {
    // Given a compressed import that hangs after staging plaintext and entering raw mode.
    const dumpPath = join(root, "dump.sql.gz");
    await writeFile(dumpPath, Bun.gzipSync("select 1;"));
    const staged = Promise.withResolvers<string>();

    const run = runWithProcessAbortSignal(
      () =>
        runCompiledCommand(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  stdin.setRawMode?.(true);
                }),
                () =>
                  Effect.sync(() => {
                    stdin.setRawMode?.(false);
                  }),
              );
              return yield* withHostDumpCompression({
                path: dumpPath,
                compression: "gzip",
                direction: "import",
                transfer: (workingPath) =>
                  Effect.sync(() => staged.resolve(workingPath)).pipe(Effect.andThen(Effect.never)),
              });
            }),
          ),
          Layer.empty,
          () => undefined,
          { suppressInterruptionDiagnostics: true },
        ),
      { signals: ["SIGINT"] },
    );

    const workingPath = await staged.promise;
    const stagedDir = dirname(workingPath);
    expect(basename(stagedDir).startsWith(dumpPrefix)).toBe(true);
    expect(existsSync(stagedDir)).toBe(true);
    expect(stdin.isRaw).toBe(true);

    // When the process abort signal interrupts the running fiber.
    process.emit("SIGINT");
    await run;

    // Then the .lando-dump-* directory is gone and stdin is not left in raw mode.
    expect(existsSync(stagedDir)).toBe(false);
    expect(stdin.isRaw).toBe(false);
    expect(raw).toBe(false);
  }, 15_000);
});
