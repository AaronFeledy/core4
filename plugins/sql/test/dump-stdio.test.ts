import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CommandStdioError, SqlConfirmRequiredError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { dbInputFromCommand } from "../src/command-input.ts";
import { spec as exportSpec } from "../src/commands/export.ts";
import { spec as importSpec } from "../src/commands/import.ts";
import { spec as seedSpec } from "../src/commands/seed.ts";
import { executeDbCommand } from "../src/execute.ts";
import { dumpCommand } from "../src/families.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

const run = (
  deps: ReturnType<typeof makeSqlTestDeps>["deps"],
  input: Parameters<typeof executeDbCommand>[1],
) => Effect.runPromiseExit(Effect.scoped(executeDbCommand(deps, input)));

const SECRET = "s3cret-pass";

describe("db dump stdio", () => {
  test("export/import/seed declare dash stdio and carry grants through command input", () => {
    // Given
    const exportInput = {
      argv: [],
      parsedArgv: ["-"],
      flags: {},
      args: { file: "-" },
      stdio: { stdout: () => Effect.void },
    };
    const importInput = {
      argv: [],
      parsedArgv: ["-"],
      flags: { yes: true },
      args: { file: "-" },
      stdio: { stdin: Stream.empty },
    };
    // When / Then
    expect(exportSpec.args.file.stdio).toBe("stdout");
    expect(importSpec.args.file.stdio).toBe("stdin");
    expect(seedSpec.args.file.stdio).toBe("stdin");
    expect(dbInputFromCommand("export", exportInput).stdio?.stdout).toBe(exportInput.stdio.stdout);
    expect(dbInputFromCommand("import", importInput).stdio?.stdin).toBe(importInput.stdio.stdin);
  });

  test("exports exact bytes including a registered secret and invalid UTF-8 through granted stdout", async () => {
    // Given: payload mixes a secret substring and invalid UTF-8 bytes.
    const payload = Uint8Array.from([...new TextEncoder().encode(`dump:${SECRET}:`), 0xff, 0xfe, 0x00]);
    const chunks: Uint8Array[] = [];
    const harness = makeSqlTestDeps({ password: SECRET, readPayload: payload });
    // When
    const exit = await run(harness.deps, {
      action: "export",
      yes: false,
      file: "-",
      stdio: {
        stdout: (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
      },
    });
    // Then
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.file).toBe("-");
    expect(exit.value.accelerated).toBe(false);
    expect(exit.value.sizeBytes).toBe(payload.byteLength);
    const written = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
    expect(written).toEqual(payload);
    expect(harness.transfers()).toEqual([]);
    expect(harness.reads()).toHaveLength(1);
    const from = harness.reads()[0];
    expect(from?._tag).toBe("serviceCmd");
    if (from?._tag === "serviceCmd") {
      expect(from.command).toEqual(dumpCommand("mysql", { user: "lando", database: "sql-app", port: 3306 }));
      expect(Object.values(from.env ?? {}).join(" ")).toContain(SECRET);
      expect([...(from.secrets?.substring ?? []), ...(from.secrets?.wholeToken ?? [])]).toContain(SECRET);
    }
  });

  test.each(["gzip", "zstd"] as const)(
    "export - --compression=%s compresses the stream on the host",
    async (compression) => {
      // Given
      const payload = new TextEncoder().encode("-- MySQL dump\nCREATE TABLE t (id int);\n".repeat(2000));
      const chunks: Uint8Array[] = [];
      const harness = makeSqlTestDeps({ password: SECRET, readPayload: payload });
      // When
      const exit = await run(harness.deps, {
        action: "export",
        yes: false,
        file: "-",
        compression,
        stdio: {
          stdout: (chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
            }),
        },
      });
      // Then
      if (!Exit.isSuccess(exit)) throw new Error(`export failed: ${Cause.pretty(exit.cause)}`);
      const written = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
      const decoded = compression === "gzip" ? Bun.gunzipSync(written) : Bun.zstdDecompressSync(written);
      expect(new Uint8Array(decoded)).toEqual(payload);
      expect(exit.value.sizeBytes).toBe(written.byteLength);
    },
  );

  test("a failing stdout write stops the compressed dump and releases its source", async () => {
    // Given: the reader went away after the first chunk.
    let released = false;
    const harness = makeSqlTestDeps({ password: SECRET });
    const deps = {
      ...harness.deps,
      read: () =>
        // A large first chunk makes the compressor emit output before the source stalls.
        Stream.make(Uint8Array.from({ length: 1 << 20 }, (_, index) => (index * 2_654_435_761) >>> 24)).pipe(
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
    };
    // When
    const exit = await run(deps, {
      action: "export",
      yes: false,
      file: "-",
      compression: "gzip",
      stdio: { stdout: () => Effect.interrupt },
    });
    // Then
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(released).toBe(true);
  });

  test("mssql export - backs up then reads the service .bak path", async () => {
    // Given
    const payload = new TextEncoder().encode("MSSQLBAK");
    const chunks: Uint8Array[] = [];
    const harness = makeSqlTestDeps({
      password: SECRET,
      type: "mssql:2022",
      readPayload: payload,
      environment: { MSSQL_SA_PASSWORD: SECRET },
    });
    // When
    const exit = await run(harness.deps, {
      action: "export",
      yes: false,
      file: "-",
      stdio: {
        stdout: (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
      },
    });
    // Then
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.file).toBe("-");
    expect(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))).toEqual(payload);
    expect(harness.reads()[0]).toMatchObject({
      _tag: "servicePath",
      path: "/var/opt/mssql/backup/sql-app.bak",
    });
    expect(harness.execs().some((entry) => entry.command.join(" ").includes("BACKUP DATABASE"))).toBe(true);
    expect(harness.transfers()).toEqual([]);
  });

  test("import - without --yes fails before reading stdin or counting", async () => {
    // Given
    let stdinPulled = false;
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "3" });
    // When
    const exit = await run(harness.deps, {
      action: "import",
      yes: false,
      file: "-",
      stdio: {
        stdin: Stream.unwrap(
          Effect.sync(() => {
            stdinPulled = true;
            return Stream.succeed(new TextEncoder().encode("select 1;"));
          }),
        ),
      },
    });
    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlConfirmRequiredError);
    if (!(error instanceof SqlConfirmRequiredError)) return;
    expect(error.remediation).toContain("--yes");
    expect(error.remediation.toLowerCase()).toContain("stdin");
    expect(stdinPulled).toBe(false);
    expect(harness.countAttempts()).toBe(0);
    expect(harness.transfers()).toEqual([]);
    expect(harness.execs()).toEqual([]);
  });

  test("import - --yes stages plain and gzip stdin before the trusted import path", async () => {
    for (const [label, raw, expectedWorking] of [
      ["plain", new TextEncoder().encode("select plain;"), "select plain;"],
      ["gzip", Bun.gzipSync("select gzip;"), "select gzip;"],
    ] as const) {
      // Given
      const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });
      let workingBytes: Uint8Array | undefined;
      let workingPath = "";
      const deps = {
        ...harness.deps,
        transfer: (spec: Parameters<typeof harness.deps.transfer>[0]) =>
          Effect.gen(function* () {
            if (spec.from._tag === "hostPath") {
              workingPath = spec.from.path;
              workingBytes = new Uint8Array(readFileSync(spec.from.path));
              expect(statSync(spec.from.path).mode & 0o777).toBe(0o600);
              expect(spec.from.trusted).toBe(true);
              expect(spec.from.path).not.toBe("-");
            }
            return yield* harness.deps.transfer(spec);
          }),
      };
      // When
      const exit = await run(deps, {
        action: "import",
        yes: true,
        file: "-",
        stdio: { stdin: Stream.succeed(raw) },
      });
      // Then: stdin is staged, compression detected from magic, working path is plaintext SQL.
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) throw new Error(`${label} import failed`);
      expect(exit.value.file).toBe("-");
      expect(isAbsolute(workingPath)).toBe(true);
      // The staged copy lives only as long as the command scope.
      expect(existsSync(workingPath)).toBe(false);
      expect(new TextDecoder().decode(workingBytes)).toBe(expectedWorking);
    }
  });

  test("seed - stages granted stdin into a fresh database", async () => {
    // Given
    const payload = new TextEncoder().encode("seed dump;");
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });
    let stagedBytes: Uint8Array | undefined;
    const deps = {
      ...harness.deps,
      transfer: (spec: Parameters<typeof harness.deps.transfer>[0]) =>
        Effect.gen(function* () {
          if (spec.from._tag === "hostPath") {
            stagedBytes = new Uint8Array(readFileSync(spec.from.path));
          }
          return yield* harness.deps.transfer(spec);
        }),
    };
    // When
    const exit = await run(deps, {
      action: "seed",
      yes: false,
      file: "-",
      stdio: { stdin: Stream.succeed(payload) },
    });
    // Then
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.seedStatus).toBe("seeded");
    expect(stagedBytes).toEqual(new Uint8Array(payload));
    expect(exit.value.file).toBe("-");
  });

  test("missing stdio grant fails unavailable before provider work or exec", async () => {
    // Given
    const harness = makeSqlTestDeps({ password: SECRET });
    // When
    const exportExit = await run(harness.deps, { action: "export", yes: false, file: "-" });
    const importExit = await run(harness.deps, { action: "import", yes: true, file: "-" });
    // Then
    for (const [exit, stream] of [
      [exportExit, "stdout"],
      [importExit, "stdin"],
    ] as const) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) continue;
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(CommandStdioError);
      if (!(error instanceof CommandStdioError)) continue;
      expect(error.reason).toBe("unavailable");
      expect(error.stream).toBe(stream);
      expect(error.remediation.toLowerCase()).toContain("terminal");
    }
    expect(harness.transfers()).toEqual([]);
    expect(harness.reads()).toEqual([]);
    expect(harness.execs()).toEqual([]);
    expect(harness.countAttempts()).toBe(0);
    expect(harness.lifecycle()).toEqual([]);
  });

  test("export - rejects --compression-level through the existing validator", async () => {
    // Given
    const harness = makeSqlTestDeps({ password: SECRET });
    // When
    const exit = await run(harness.deps, {
      action: "export",
      yes: false,
      file: "-",
      compressionLevel: 6,
      stdio: { stdout: () => Effect.void },
    });
    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
      _tag: "CommandInputValidationError",
      target: "db:export",
      field: "compression-level",
      kind: "flag",
      reason: "constraint",
    });
    expect(harness.reads()).toEqual([]);
    expect(harness.execs()).toEqual([]);
  });

  test("keeps CommandStdioError read failures from granted stdin", async () => {
    // Given
    const harness = makeSqlTestDeps({ password: SECRET, countStdout: "0" });
    const failure = new CommandStdioError({
      message: "stdin closed early.",
      command: "db:import",
      stream: "stdin",
      reason: "read",
      remediation: "Retry the import with a complete dump on stdin.",
    });
    // When
    const exit = await run(harness.deps, {
      action: "import",
      yes: true,
      file: "-",
      stdio: { stdin: Stream.fail(failure) },
    });
    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBe(failure);
    expect(harness.transfers()).toEqual([]);
  });
});
