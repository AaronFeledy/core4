import { afterEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { CommandInputValidationError } from "@lando/sdk/errors";

import { dbInputFromCommand, validateExportCompressionLevel } from "../src/command-input.ts";
import { spec as exportSpec } from "../src/commands/export.ts";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

describe("export compression level input", () => {
  test.each(["1.5", "NaN", "Infinity", "9007199254740992"])("rejects non-integer %s at parse time", (raw) => {
    // Given / When / Then
    expect(() => exportSpec.flags["compression-level"].parse(raw)).toThrow(RangeError);
  });

  test.each([
    ["dump.sql.gz", -1, "gzip --compression-level must be between 0 and 9."],
    ["dump.sql.gz", 10, "gzip --compression-level must be between 0 and 9."],
    ["dump.sql.zst", 0, "zstd --compression-level must be between 1 and 22."],
    ["dump.sql.zst", 23, "zstd --compression-level must be between 1 and 22."],
    ["dump.sql", 1, "--compression-level cannot be used with an uncompressed export."],
    ["dump.sql.gz", 1.5, "--compression-level must be an integer."],
    ["dump.sql.gz", Number.NaN, "--compression-level must be an integer."],
    ["dump.sql.gz", Number.POSITIVE_INFINITY, "--compression-level must be an integer."],
    ["dump.sql.gz", Number.MAX_SAFE_INTEGER + 1, "--compression-level must be an integer."],
    ["dump.sql", Number.NaN, "--compression-level must be an integer."],
  ] as const)("rejects %s level %s before any execution", async (file, compressionLevel, message) => {
    // Given
    const harness = makeSqlTestDeps({ password: "secret" });

    // When
    const exit = await Effect.runPromiseExit(
      executeDbCommand(harness.deps, { action: "export", yes: true, file, compressionLevel }),
    );

    // Then
    if (!Exit.isFailure(exit)) throw new Error("expected input validation failure");
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(CommandInputValidationError);
    expect(error).toMatchObject({
      _tag: "CommandInputValidationError",
      target: "db:export",
      field: "compression-level",
      kind: "flag",
      reason: "constraint",
      message,
      remediation:
        "Use an integer from 0-9 with a .gz destination or 1-22 with a .zst destination, or omit --compression-level.",
    });
    expect(harness.transfers()).toEqual([]);
    expect(harness.execs()).toEqual([]);
    expect(harness.published()).toEqual([]);
    expect(harness.lifecycle()).toEqual([]);
  });

  test.each([
    ["dump.sql.gz", 0],
    ["dump.sql.gz", 9],
    ["dump.sql.zst", 1],
    ["dump.sql.zst", 22],
    [undefined, 0],
  ] as const)("accepts %s level %s at the input boundary", async (file, compressionLevel) => {
    // Given
    const input = {
      action: "export",
      yes: true,
      compressionLevel,
      ...(file === undefined ? {} : { file }),
    } as const;

    // When
    const exit = await Effect.runPromiseExit(validateExportCompressionLevel(input));

    // Then
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test.each(["dump.sql.gz", "dump.sql.zst", "dump.sql"])(
    "keeps the default when omitted for %s",
    async (file) => {
      // Given
      const input = dbInputFromCommand("export", { argv: [], parsedArgv: [], flags: {}, args: { file } });

      // When
      const exit = await Effect.runPromiseExit(validateExportCompressionLevel(input));

      // Then
      expect(input).not.toHaveProperty("compressionLevel");
      expect(Exit.isSuccess(exit)).toBe(true);
    },
  );

  test("preserves zero from the flag parser through command input", () => {
    // Given
    const level = exportSpec.flags["compression-level"].parse("0");

    // When
    const input = dbInputFromCommand("export", {
      argv: [],
      parsedArgv: [],
      args: {},
      flags: { "compression-level": level },
    });

    // Then
    expect(input.compressionLevel).toBe(0);
  });

  for (const [compression, file, level] of [
    ["gzip", "dump.sql.gz", 0],
    ["zstd", "dump.sql.zst", 19],
  ] as const) {
    test(`writes the requested ${compression} level through the export command pipeline`, async () => {
      // Given
      const harness = makeSqlTestDeps({ password: "secret" });
      const payload = "INSERT INTO items VALUES (1, 'a repeatable database value');\n".repeat(1000);
      const input = dbInputFromCommand("export", {
        argv: [],
        parsedArgv: [],
        args: { file },
        flags: { "compression-level": exportSpec.flags["compression-level"].parse(String(level)) },
      });
      const expected = await new Response(
        new Blob([payload]).stream().pipeThrough(new CompressionStream(compression, { level })),
      ).bytes();

      // When
      const result = await Effect.runPromise(
        executeDbCommand(
          {
            ...harness.deps,
            transfer: (spec) =>
              Effect.promise(async () => {
                if (spec.to._tag !== "hostPath") throw new Error("expected a host dump destination");
                await Bun.write(spec.to.path, payload);
                return { accelerated: false, sizeBytes: payload.length };
              }),
          },
          input,
        ),
      );

      // Then
      if (result.file === undefined) throw new Error("expected an exported file");
      expect(await Bun.file(result.file).bytes()).toEqual(new Uint8Array(expected));
      expect(result.sizeBytes).toBe(expected.byteLength);
      expect(
        await new Response(
          Bun.file(result.file).stream().pipeThrough(new DecompressionStream(compression)),
        ).text(),
      ).toBe(payload);
    });
  }
});
