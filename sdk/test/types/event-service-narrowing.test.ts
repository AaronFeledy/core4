import { describe, expect, test } from "bun:test";

import { type Context, DateTime, type Effect, Schema, type Stream } from "effect";

import type {
  BuildStepSkipEvent,
  CliCommandErrorEvent,
  CliCommandInitEvent,
  CliCommandRunEvent,
  DownloadProgressEvent,
  LandoEvent as KnownLandoEvent,
} from "@lando/sdk/events";
import { CliCommandRunEvent as CliCommandRunEventSchema } from "@lando/sdk/events";
import type { EventService, LandoEvent } from "@lando/sdk/services";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const assertType = <T extends true>(value: T): T => value;

type StreamValue<T> = T extends Stream.Stream<infer A, unknown, unknown> ? A : never;
type EffectValue<T> = T extends Effect.Effect<infer A, unknown, unknown> ? A : never;

type Service = Context.Tag.Service<typeof EventService>;
declare const service: Service;

type SubscribeFor<Name extends string> = StreamValue<ReturnType<typeof service.subscribe<Name>>>;
type WaitForResult<Name extends string> = EffectValue<ReturnType<typeof service.waitFor<Name>>>;
type QueryResult<Name extends string> = EffectValue<ReturnType<typeof service.query<Name>>>;
type WaitForAnyResult<Names extends readonly string[]> = EffectValue<
  ReturnType<typeof service.waitForAny<Names>>
>;

describe("EventService typed narrowing", () => {
  test("subscribe narrows on the tag literal, '*' to the union, dynamic to loose", () => {
    assertType<Equal<SubscribeFor<"download-progress">, DownloadProgressEvent>>(true);
    assertType<Equal<SubscribeFor<"build-step-skip">, BuildStepSkipEvent>>(true);
    assertType<Equal<SubscribeFor<"*">, KnownLandoEvent>>(true);
    assertType<Equal<SubscribeFor<string>, LandoEvent>>(true);
    expect(true).toBe(true);
  });

  test("waitFor narrows the resolved event and '*' to the union", () => {
    assertType<Equal<WaitForResult<"download-progress">, DownloadProgressEvent>>(true);
    assertType<Equal<WaitForResult<"*">, KnownLandoEvent>>(true);
    expect(true).toBe(true);
  });

  test("waitForAny resolves the union of its specs", () => {
    type Resolved = WaitForAnyResult<["download-progress", "pre-download"]>;
    assertType<Equal<Extract<Resolved, { readonly _tag: "download-progress" }>, DownloadProgressEvent>>(true);
    expect(true).toBe(true);
  });

  test("query narrows the buffered result array", () => {
    assertType<Equal<QueryResult<"download-progress">, ReadonlyArray<DownloadProgressEvent>>>(true);
    expect(true).toBe(true);
  });

  test("subscribe and waitFor narrow to the same event type for the same name", () => {
    assertType<Equal<SubscribeFor<"download-progress">, WaitForResult<"download-progress">>>(true);
    expect(true).toBe(true);
  });

  test("dynamic CLI lifecycle tags narrow to their canonical event variants", () => {
    // Given / When / Then: resolving each canonical dynamic tag selects its schema variant.
    assertType<Equal<SubscribeFor<"cli-app:start-init">, CliCommandInitEvent>>(true);
    assertType<Equal<WaitForResult<"cli-app:start-run">, CliCommandRunEvent>>(true);
    assertType<Equal<QueryResult<"cli-app:start-error">, ReadonlyArray<CliCommandErrorEvent>>>(true);
    expect(true).toBe(true);
  });

  test("the runtime CLI schema recognizes the same dynamic tag used for narrowing", () => {
    // Given
    const event = {
      _tag: "cli-app:start-run",
      commandId: "app:start",
      argv: ["start"],
      args: {},
      flags: {},
      cwd: "/workspace/demo",
      exitCode: 0,
      durationMs: 5,
      timestamp: DateTime.unsafeMake("2026-07-13T16:00:00.000Z"),
    };

    // When
    const matches = Schema.is(CliCommandRunEventSchema)(event);

    // Then
    expect(matches).toBe(true);
  });
});
