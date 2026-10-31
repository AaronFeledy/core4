import { expect, test } from "bun:test";
import type { ExecutableCommandLoader, ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Effect, Schema } from "effect";

import type { pluginOwnedCommandEffect } from "../../src/cli/run-plugin-owned-command";
import type { LandoCommandSpec } from "../../src/cli/spec/command-spec";

type Assignable<A, B> = [A] extends [B] ? true : false;

const Result = Schema.Struct({
  id: Schema.String.pipe(Schema.brand("CommandResultId")),
  values: Schema.Array(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
type Result = typeof Result.Type;

test("rejects a schema with a different success type", () => {
  const rejected: Assignable<
    Omit<LandoCommandSpec<Result>, "resultSchema"> & { readonly resultSchema: typeof Schema.Number },
    LandoCommandSpec<Result>
  > = false;
  expect(rejected).toBe(false);
});

test("rejects a run whose success value differs from the declared schema", () => {
  const rejected: Assignable<
    Omit<LandoCommandSpec<Result>, "run"> & { readonly run: () => Effect.Effect<number> },
    LandoCommandSpec<Result>
  > = false;
  expect(rejected).toBe(false);
});

test("requires a result schema even when the rest of the spec is valid", () => {
  const rejected: Assignable<
    Omit<LandoCommandSpec<Result>, "resultSchema">,
    LandoCommandSpec<Result>
  > = false;
  expect(rejected).toBe(false);
});

test("rejects a render hook for an unrelated result", () => {
  const rejected: Assignable<
    Omit<LandoCommandSpec<Result>, "render"> & { readonly render: (result: number) => string },
    LandoCommandSpec<Result>
  > = false;
  expect(rejected).toBe(false);
});

test("rejects a redaction hook for an unrelated result", () => {
  // Given / When
  const rejected: Assignable<
    Omit<LandoCommandSpec<Result>, "redactionTokens"> & {
      readonly redactionTokens: (result: number) => ReadonlyArray<string>;
    },
    LandoCommandSpec<Result>
  > = false;
  // Then
  expect(rejected).toBe(false);
});

test("preserves branded, readonly, optional results through registry erasure", () => {
  const spec = {
    id: "meta:typed",
    summary: "Typed command",
    namespace: "meta",
    bootstrap: "minimal",
    resultSchema: Result,
    run: () => Effect.succeed(Result.make({ id: Result.fields.id.make("id"), values: ["value"] })),
    render: (result: Result) => result.values.join(","),
    streamFrames: (_result: Result) => [],
    redactionTokens: (result: Result) => result.values,
    completion: (_result: Result) => ({ exitCode: 0, ok: true as const }),
  } satisfies LandoCommandSpec<Result>;
  const typed: Assignable<typeof spec, LandoCommandSpec<Result>> = true;
  const erased: Assignable<typeof spec, LandoCommandSpec> = true;
  const live: LandoCommandSpec<Result> = { ...spec, streamingMode: "live" };
  expect([typed, erased, live.streamingMode]).toEqual([true, true, "live"]);
});

test("accepts a typed plugin spec at the command loader boundary", () => {
  const spec = {
    id: "example:typed",
    summary: "Typed plugin command",
    namespace: "example",
    bootstrap: "minimal",
    resultSchema: Result,
    run: () => Effect.succeed(Result.make({ id: Result.fields.id.make("id"), values: [] })),
    render: ({ result }) => Effect.succeed(result.values.join(",")).pipe(Effect.asVoid),
    redactionTokens: (result) => result.values,
  } satisfies ExecutableCommandSpec<Result, never, never>;
  const accepted: Assignable<() => Promise<typeof spec>, ExecutableCommandLoader> = true;
  const executable: Assignable<
    typeof spec,
    Parameters<typeof pluginOwnedCommandEffect<Result, never, never>>[0]
  > = true;
  expect(accepted).toBe(true);
  expect(executable).toBe(true);
});
