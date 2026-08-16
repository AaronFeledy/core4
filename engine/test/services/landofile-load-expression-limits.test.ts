import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { LandofileLoadLimitError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, LandofileService } from "@lando/sdk/services";

import { LandofileServiceLive } from "../../src/services/landofile-live";
import { resolveLandofileLoadExpressions } from "@lando/landofile/load-expression";
import { IMPORTED_PEM, PEM, withApp } from "./landofile-load-expression-support.ts";

test("enforces the configured recursion limit", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    security:",
        "      ca:",
        "        - \"{{ load(load('./corp.pem')) }}\"",
        "",
      ].join("\n"),
    );
    const config = Schema.decodeUnknownSync(GlobalConfig)({ loadMaxRecursionDepth: 1 });
    const layer = Layer.merge(
      LandofileServiceLive,
      Layer.succeed(ConfigService, {
        load: Effect.succeed(config),
        get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
      }),
    );

    // When
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(LandofileService, (service) => service.discover).pipe(Effect.provide(layer)),
    );

    // Then
    if (Exit.isSuccess(exit)) throw new Error("expected limit failure");
    expect(Option.getOrThrow(Cause.failureOption(exit.cause))).toBeInstanceOf(LandofileLoadLimitError);
  });
});

test("enforces the file-byte limit", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "one.pem"), PEM);
    const source = {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical" as const,
    };

    // When
    const exit = await Effect.runPromiseExit(
      resolveLandofileLoadExpressions({
        value: "{{ load('./one.pem') }}",
        source,
        policy: {
          allowOutsideRoot: false,
          maxFileBytes: 1,
          maxFilesPerExpression: 16,
          maxRecursionDepth: 4,
        },
      }),
    );

    // Then
    if (Exit.isSuccess(exit)) throw new Error("expected load limit");
    expect(Option.getOrThrow(Cause.failureOption(exit.cause))).toMatchObject({ kind: "file-bytes" });
  });
});

test("reports binary FileRef encoding for invalid UTF-8 bytes", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "binary.dat"), new Uint8Array([0xff, 0xfe]));
    const source = {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical" as const,
    };

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileLoadExpressions({
        value: "{{ load('./binary.dat').encoding }}",
        source,
        policy: {
          allowOutsideRoot: false,
          maxFileBytes: 1_048_576,
          maxFilesPerExpression: 16,
          maxRecursionDepth: 4,
        },
      }),
    );

    // Then
    expect(resolved.value).toBe("binary");
  });
});

test("enforces the per-expression file-count limit", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "one.pem"), PEM);
    await writeFile(join(appRoot, "two.pem"), IMPORTED_PEM);
    const source = {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical" as const,
    };

    // When
    const exit = await Effect.runPromiseExit(
      resolveLandofileLoadExpressions({
        value: "{{ [load('./one.pem'), load('./two.pem')] }}",
        source,
        policy: {
          allowOutsideRoot: false,
          maxFileBytes: 1_048_576,
          maxFilesPerExpression: 1,
          maxRecursionDepth: 4,
        },
      }),
    );

    // Then
    if (Exit.isSuccess(exit)) throw new Error("expected load limit");
    expect(Option.getOrThrow(Cause.failureOption(exit.cause))).toMatchObject({
      kind: "files-per-expression",
    });
  });
});
