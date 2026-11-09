import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";

import {
  CommandInputValidationError,
  CommandStdioError,
  SqlDumpCompressionError,
  SqlDumpIncompleteError,
  SqlDumpNotFoundError,
} from "@lando/sdk/errors";

import { ensureDumpFile, prepareImportDump } from "../src/dump-file.ts";
import { ensureExportDestination } from "../src/export-destination.ts";
import { dumpCompleteness } from "../src/families.ts";

const sha256 = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const MYSQL_DUMP =
  "-- MySQL dump 10.13  Distrib 8.4.3\n--\nCREATE TABLE t (id int);\n-- Dump completed on 2026-11-04 10:00:00\n";
const MARIADB_DUMP =
  "/*M!999999\\- enable the sandbox mode */ \n-- MariaDB dump 10.19-11.4.5-MariaDB\nCREATE TABLE t (id int);\n-- Dump completed on 2026-11-04 10:00:00\n";
const PG_DUMP =
  "--\n-- PostgreSQL database dump\n--\n\n\\restrict abc\nCREATE TABLE t (id int);\n--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict abc\n\n";

const noPrivateAccess = { enforce: async () => undefined, verify: async () => undefined };

describe("dump files", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-sql-dump-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const prepare = (
    input: Omit<
      Parameters<typeof prepareImportDump>[0],
      "stagingDir" | "privateFileAccess" | "completeness"
    > & {
      readonly completeness?: Parameters<typeof prepareImportDump>[0]["completeness"];
    },
  ) =>
    Effect.runPromiseExit(
      Effect.scoped(
        prepareImportDump({
          completeness: dumpCompleteness("mysql"),
          ...input,
          stagingDir: join(root, "staging"),
          privateFileAccess: noPrivateAccess,
        }).pipe(
          Effect.flatMap((prepared) =>
            Effect.promise(async () => ({
              ...prepared,
              bytes: await readFile(prepared.path, "utf8"),
              mode: (await stat(prepared.path)).mode & 0o777,
            })),
          ),
        ),
      ),
    );

  describe("ensureDumpFile", () => {
    test("reports a missing file", async () => {
      const path = join(root, "missing.sql.gz");
      const error = failureOf(await Effect.runPromiseExit(ensureDumpFile(path, root)));
      expect(error).toBeInstanceOf(SqlDumpNotFoundError);
      expect(error).toMatchObject({ path, appRoot: root });
    });

    test("reports a directory", async () => {
      const path = join(root, "dump-dir");
      await mkdir(path);
      const error = failureOf(await Effect.runPromiseExit(ensureDumpFile(path, root)));
      expect(error).toBeInstanceOf(SqlDumpNotFoundError);
      expect(error).toMatchObject({ path });
    });

    test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
      "reports a file the user cannot read",
      async () => {
        const path = join(root, "locked.sql");
        await writeFile(path, "x");
        await chmod(path, 0o000);
        const error = failureOf(await Effect.runPromiseExit(ensureDumpFile(path, root)));
        expect(error).toBeInstanceOf(SqlDumpNotFoundError);
        expect(error).toMatchObject({ path });
      },
    );
  });

  describe("prepareImportDump", () => {
    test.each(["none", "gzip", "zstd"] as const)(
      "preserves raw SQLite bytes from %s stdin",
      async (compression) => {
        const bytes = new TextEncoder().encode("SQLite format 3\0payload");
        const input =
          compression === "gzip"
            ? Bun.gzipSync(bytes)
            : compression === "zstd"
              ? Bun.zstdCompressSync(bytes)
              : bytes;
        const exit = await prepare({
          file: "-",
          appRoot: root,
          completeness: undefined,
          stdin: Stream.make(input),
        });
        if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause));
        expect(exit.value.bytes).toBe(new TextDecoder().decode(bytes));
        expect(exit.value.digest).toBe(sha256(bytes));
      },
    );
    test.each([
      ["mysql", PG_DUMP.split("CREATE")[0]],
      ["mariadb", PG_DUMP.split("CREATE")[0]],
      ["postgres", MYSQL_DUMP.split("CREATE")[0]],
      ["mongodb", MYSQL_DUMP.split("CREATE")[0]],
      ["mssql", MYSQL_DUMP.split("CREATE")[0]],
    ] as const)("only applies the %s target family's completeness rule", async (family, dump) => {
      const exit = await prepare({
        file: "-",
        appRoot: root,
        completeness: dumpCompleteness(family),
        stdin: Stream.make(new TextEncoder().encode(dump)),
      });
      expect(Exit.isSuccess(exit)).toBe(true);
    });
    test("hashes an uncompressed file in place instead of copying it", async () => {
      const path = join(root, "plain.sql.gz");
      await writeFile(path, "select 1;\n");
      const exit = await prepare({ file: path, appRoot: root });
      expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ path, digest: sha256("select 1;\n") });
    });

    test.each([
      ["gzip", (text: string) => Bun.gzipSync(text)],
      ["zstd", (text: string) => Bun.zstdCompressSync(text)],
    ] as const)(
      "decompresses %s detected from its bytes into an owner-only staged copy",
      async (_label, compress) => {
        const path = join(root, "dump.sql");
        await writeFile(path, compress(PG_DUMP));
        const exit = await prepare({ file: path, appRoot: root, completeness: dumpCompleteness("postgres") });
        if (!Exit.isSuccess(exit)) throw new Error(`prepare failed: ${Cause.pretty(exit.cause)}`);
        expect(exit.value.path).not.toBe(path);
        expect(exit.value.bytes).toBe(PG_DUMP);
        expect(exit.value.digest).toBe(sha256(PG_DUMP));
        if (process.platform !== "win32") expect(exit.value.mode).toBe(0o600);
        expect(exit.value.path.startsWith(join(root, "staging"))).toBe(true);
        expect(existsSync(exit.value.path)).toBe(false);
      },
    );

    test("makes the staging directories and the staged file private before any dump byte is written", async () => {
      // Given private-access hooks that record each path and how much of the staged file exists.
      const staging = join(root, "staging");
      const calls: string[] = [];
      const record = (operation: string) => async (path: string) => {
        const size = existsSync(path) && (await stat(path)).isFile() ? (await stat(path)).size : undefined;
        calls.push(
          `${operation} ${path.startsWith(staging) ? path.slice(staging.length) || "/" : path}${size === undefined ? "" : ` size=${size}`}`,
        );
      };
      // When stdin is staged.
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          prepareImportDump({
            file: "-",
            appRoot: root,
            stagingDir: staging,
            privateFileAccess: { enforce: record("enforce"), verify: record("verify") },
            stdin: Stream.make(new TextEncoder().encode(MYSQL_DUMP)),
            completeness: dumpCompleteness("mysql"),
          }),
        ),
      );
      // Then the shared directory, the per-dump directory, and the empty temp file are each enforced and verified.
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(calls.slice(0, 2)).toEqual(["enforce /", "verify /"]);
      expect(calls[2]).toMatch(/^enforce \/sql-dump-[^/]+$/u);
      expect(calls[4]).toMatch(/^enforce \/sql-dump-[^/]+\/dump\.tmp-.+ size=0$/u);
      expect(calls[5]).toMatch(/^verify .+ size=0$/u);
      if (process.platform !== "win32") expect((await stat(staging)).mode & 0o777).toBe(0o700);
    });

    test("stages stdin, including compressed stdin, and removes the copy when the scope closes", async () => {
      const exit = await prepare({ file: "-", appRoot: root, stdin: Stream.make(Bun.gzipSync(MYSQL_DUMP)) });
      if (!Exit.isSuccess(exit)) throw new Error(`prepare failed: ${Cause.pretty(exit.cause)}`);
      expect(exit.value.bytes).toBe(MYSQL_DUMP);
      expect(existsSync(exit.value.path)).toBe(false);
    });

    test.each([
      ["a file", (path: string) => ({ file: path })],
      ["stdin", () => ({ file: "-", stdin: Stream.empty })],
    ] as const)("rejects an empty dump from %s", async (_label, source) => {
      const path = join(root, "empty.sql");
      await writeFile(path, "");
      const error = failureOf(await prepare({ appRoot: root, ...source(path) }));
      expect(error).toBeInstanceOf(SqlDumpIncompleteError);
      expect(error).toMatchObject({ reason: "empty" });
    });

    test("rejects a gzip stream whose content is empty", async () => {
      const path = join(root, "empty.sql.gz");
      await writeFile(path, Bun.gzipSync(""));
      expect(failureOf(await prepare({ file: path, appRoot: root }))).toMatchObject({ reason: "empty" });
    });

    test.each([
      ["mysql", MYSQL_DUMP],
      ["mariadb", MARIADB_DUMP],
      ["postgres", PG_DUMP],
    ] as const)(
      "accepts a complete %s dump and rejects one cut off before its trailer",
      async (family, dump) => {
        const complete = join(root, "complete.sql");
        const cut = join(root, "cut.sql");
        await writeFile(complete, dump);
        await writeFile(cut, dump.slice(0, dump.indexOf("CREATE TABLE") + 20));
        expect(
          Exit.isSuccess(
            await prepare({ file: complete, appRoot: root, completeness: dumpCompleteness(family) }),
          ),
        ).toBe(true);
        const error = failureOf(
          await prepare({ file: cut, appRoot: root, completeness: dumpCompleteness(family) }),
        );
        expect(error).toBeInstanceOf(SqlDumpIncompleteError);
        expect(error).toMatchObject({ reason: "truncated", path: cut });
      },
    );

    test("finds a trailer that ends far from the header in a large dump", async () => {
      const body = "INSERT INTO t VALUES (1);\n".repeat(100_000);
      const exit = await prepare({
        file: "-",
        appRoot: root,
        stdin: Stream.make(
          new TextEncoder().encode(`${MYSQL_DUMP.split("CREATE")[0]}${body}-- Dump completed\n`),
        ),
      });
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    test("rejects a truncated dump that arrives gzip-compressed on stdin", async () => {
      // `mysqldump | gzip` writes a valid gzip stream even when mysqldump dies partway.
      const cut = MYSQL_DUMP.slice(0, MYSQL_DUMP.indexOf("-- Dump completed"));
      const error = failureOf(
        await prepare({ file: "-", appRoot: root, stdin: Stream.make(Bun.gzipSync(cut)) }),
      );
      expect(error).toMatchObject({ _tag: "SqlDumpIncompleteError", reason: "truncated", path: "stdin" });
    });

    test("ignores trailing whitespace after a trailer, even past the edge window", async () => {
      const exit = await prepare({
        file: "-",
        appRoot: root,
        stdin: Stream.make(new TextEncoder().encode(MYSQL_DUMP), new TextEncoder().encode(" \n".repeat(600))),
      });
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    test("accepts a CRLF pg_dump and a trailer split across chunks", async () => {
      const crlf = new TextEncoder().encode(PG_DUMP.replaceAll("\n", "\r\n"));
      const split = crlf.length - 40;
      const exit = await prepare({
        file: "-",
        appRoot: root,
        stdin: Stream.make(crlf.subarray(0, split), crlf.subarray(split)),
        completeness: dumpCompleteness("postgres"),
      });
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    test("does not count a trailer quoted inside SQL data", async () => {
      const cut = `${MYSQL_DUMP.split("CREATE")[0]}INSERT INTO t VALUES ('-- Dump completed on 2026-11-04');\n`;
      const error = failureOf(
        await prepare({ file: "-", appRoot: root, stdin: Stream.make(new TextEncoder().encode(cut)) }),
      );
      expect(error).toMatchObject({ _tag: "SqlDumpIncompleteError", reason: "truncated" });
    });

    test("does not count a trailer that starts mid-line at the edge of the tail window", async () => {
      // The last 512 bytes begin with the trailer text, but it sits inside an unfinished INSERT line.
      const marker = `-- Dump completed on ${"y".repeat(512 - "-- Dump completed on ".length)}`;
      const cut = `${MYSQL_DUMP.split("CREATE")[0]}INSERT INTO t VALUES ('abc${marker}`;
      const error = failureOf(
        await prepare({ file: "-", appRoot: root, stdin: Stream.make(new TextEncoder().encode(cut)) }),
      );
      expect(error).toMatchObject({ _tag: "SqlDumpIncompleteError", reason: "truncated" });
    });

    test("does not count a pg_dump footer line inside unfinished COPY data", async () => {
      const head = PG_DUMP.split("CREATE")[0];
      const cut = `${head}COPY public.t (v) FROM stdin;\n-- PostgreSQL database dump complete\n`;
      const error = failureOf(
        await prepare({
          file: "-",
          appRoot: root,
          stdin: Stream.make(new TextEncoder().encode(cut)),
          completeness: dumpCompleteness("postgres"),
        }),
      );
      expect(error).toMatchObject({ _tag: "SqlDumpIncompleteError", reason: "truncated" });
    });

    test("rejects a mongodump archive cut at a block boundary, even gzip-compressed", async () => {
      // Given a real two-collection archive (see mongo-archive.test.ts) and a cut right after the
      // first block's terminator, which a mongodump killed between writes leaves behind.
      const archive = await Bun.file(
        new URL("./fixtures/mongo-archive/concurrent.archive", import.meta.url),
      ).bytes();
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      let offset = 4;
      let terminators = 0;
      while (terminators < 2) {
        const length = view.getInt32(offset, true);
        offset += length === -1 ? 4 : length;
        if (length === -1) terminators += 1;
      }
      const cut = archive.subarray(0, offset);
      expect(cut.subarray(-4)).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));

      // Then the whole archive imports, and the cut one is refused plain or gzip-compressed.
      expect(
        Exit.isSuccess(
          await prepare({
            file: "-",
            appRoot: root,
            stdin: Stream.make(archive),
            completeness: dumpCompleteness("mongodb"),
          }),
        ),
      ).toBe(true);
      for (const bytes of [cut, Bun.gzipSync(cut)]) {
        const error = failureOf(
          await prepare({
            file: "-",
            appRoot: root,
            stdin: Stream.make(bytes),
            completeness: dumpCompleteness("mongodb"),
          }),
        );
        expect(error).toMatchObject({ _tag: "SqlDumpIncompleteError", reason: "truncated" });
      }
    });

    test("accepts hand-written SQL that carries no dump-tool header", async () => {
      const exit = await prepare({
        file: "-",
        appRoot: root,
        stdin: Stream.make(new TextEncoder().encode("INSERT INTO t VALUES (1);")),
      });
      expect(Exit.isSuccess(exit)).toBe(true);
    });

    test("reports corrupt gzip as a decompression failure", async () => {
      const path = join(root, "broken.gz");
      await writeFile(path, Bun.gzipSync(MYSQL_DUMP).subarray(0, 20));
      const error = failureOf(await prepare({ file: path, appRoot: root }));
      expect(error).toBeInstanceOf(SqlDumpCompressionError);
      expect(error).toMatchObject({ operation: "decompress", compression: "gzip" });
    });

    test.each([
      ["before the first byte", Stream.never],
      [
        "while staging",
        Stream.make(Bun.gzipSync(MYSQL_DUMP).subarray(0, 8)).pipe(Stream.concat(Stream.never)),
      ],
    ] as const)("interruption %s releases the stdin source", async (_label, source) => {
      // Given: stdin that never ends, and a signal when it starts and when it is released.
      const started = Promise.withResolvers<void>();
      let released = false;
      const stdin = Stream.unwrap(
        Effect.sync(() => {
          started.resolve();
          return source;
        }),
      ).pipe(
        // Cleanup that finishes asynchronously, like closing a pipe, must still finish first.
        Stream.ensuring(
          Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve))).pipe(
            Effect.andThen(
              Effect.sync(() => {
                released = true;
              }),
            ),
          ),
        ),
      );
      // When
      const fiber = Effect.runFork(
        Effect.scoped(
          prepareImportDump({
            file: "-",
            appRoot: root,
            stagingDir: join(root, "staging"),
            privateFileAccess: noPrivateAccess,
            stdin,
            completeness: dumpCompleteness("mysql"),
          }),
        ),
      );
      await started.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      // Then
      expect(released).toBe(true);
    });

    test("keeps a stdin read failure's own error", async () => {
      const failure = new CommandStdioError({
        message: "read failed",
        command: "db:import",
        stream: "stdin",
        reason: "read",
        remediation: "Retry.",
      });
      const stdin = Stream.concat(Stream.make(new TextEncoder().encode("select 1;")), Stream.fail(failure));
      expect(failureOf(await prepare({ file: "-", appRoot: root, stdin }))).toBe(failure);
    });
  });

  describe("ensureExportDestination", () => {
    test("allows a missing or regular-file destination", async () => {
      const existing = join(root, "dump.sql");
      await writeFile(existing, "old");
      expect(Exit.isSuccess(await Effect.runPromiseExit(ensureExportDestination(existing)))).toBe(true);
      expect(
        Exit.isSuccess(await Effect.runPromiseExit(ensureExportDestination(join(root, "new.sql")))),
      ).toBe(true);
    });

    test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
      "fails closed when the destination cannot be inspected",
      async () => {
        const locked = join(root, "locked");
        await mkdir(locked);
        await chmod(locked, 0o000);
        try {
          const error = failureOf(
            await Effect.runPromiseExit(ensureExportDestination(join(locked, "dump.sql"))),
          );
          expect(error).toMatchObject({ _tag: "DataTransferError", operation: "inspect" });
        } finally {
          await chmod(locked, 0o755);
        }
      },
    );

    test.skipIf(process.platform === "win32")(
      "refuses a dangling symlink and leaves it in place",
      async () => {
        const link = join(root, "dump.sql");
        await symlink(join(root, "missing-target.sql"), link);
        const error = failureOf(await Effect.runPromiseExit(ensureExportDestination(link)));
        expect(error).toMatchObject({
          _tag: "CommandInputValidationError",
          field: "file",
          reason: "constraint",
        });
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
      },
    );

    test("refuses a directory", async () => {
      const error = failureOf(await Effect.runPromiseExit(ensureExportDestination(root)));
      expect(error).toBeInstanceOf(CommandInputValidationError);
      expect(error).toMatchObject({ field: "file", kind: "arg", reason: "constraint" });
    });

    test.skipIf(process.platform === "win32")("refuses a named pipe and leaves it in place", async () => {
      const fifo = join(root, "dump.fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const error = failureOf(await Effect.runPromiseExit(ensureExportDestination(fifo)));
      expect(error).toBeInstanceOf(CommandInputValidationError);
      expect(error).toMatchObject({ field: "file", kind: "arg", reason: "constraint" });
      expect((await stat(fifo)).isFIFO()).toBe(true);
    });
  });
});
