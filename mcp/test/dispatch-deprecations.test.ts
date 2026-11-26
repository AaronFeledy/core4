import { expect, test } from "bun:test";
import * as DeprecationServiceLayer from "@lando/engine/deprecation/service";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { testAppGenerations } from "@lando/mcp/testing";
import type { DeprecationNotice } from "@lando/sdk/schema";
import { DeprecationService } from "@lando/sdk/services";
import { DateTime, Deferred, Effect, Schema } from "effect";
import { serverLayer, startServer } from "./server";

const notice: DeprecationNotice = {
  since: "4.2.0",
  severity: "warn",
  note: "Pass --new instead.",
};
const timestamp = "2026-11-25T12:00:00.000Z";
const record = { kind: "flag", id: "app:legacy --old", notice, timestamp };

const useOldFlag = Effect.gen(function* () {
  const deprecations = yield* DeprecationService;
  yield* deprecations.use({
    kind: "flag",
    id: "app:legacy --old",
    notice,
    timestamp: DateTime.makeUnsafe(timestamp),
  });
});

type CommandEntry = Extract<McpCommandEntry, { readonly kind: "command" }>;

const command = (id: string, run: Effect.Effect<unknown, unknown, DeprecationService>): CommandEntry => ({
  kind: "command",
  spec: { id, summary: `${id} fixture`, resultSchema: Schema.Unknown, run: () => run.pipe(Effect.as({})) },
});

const CallResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Literal(false),
    structuredContent: Schema.Struct({ deprecations: Schema.Array(Schema.Unknown) }),
  }),
});
const deprecationsOf = (response: unknown) =>
  Schema.decodeUnknownSync(CallResult)(response).result.structuredContent.deprecations;

/** Serves `entries` over stdio from one retained runtime that owns a single DeprecationService. */
const serve = <A>(
  entries: ReadonlyArray<CommandEntry>,
  body: (client: Effect.Success<ReturnType<typeof startServer>>) => Effect.Effect<A, unknown>,
) =>
  Effect.scoped(Effect.flatMap(startServer({}, 2), body)).pipe(
    Effect.provide(
      serverLayer({
        commandEntries: entries,
        defaultAllowlist: entries.map((entry) => entry.spec.id),
        apps: testAppGenerations(DeprecationServiceLayer.layer),
      }),
    ),
  );

test("concurrent calls on one retained runtime each report only their own deprecated surfaces", async () => {
  const responses = await Effect.runPromise(
    Effect.gen(function* () {
      // Given: one call uses a deprecated flag, twice, while a call that uses none is in flight.
      const currentStarted = yield* Deferred.make<void>();
      const legacyRecorded = yield* Deferred.make<void>();
      const legacy = command(
        "app:legacy",
        Deferred.await(currentStarted).pipe(
          Effect.andThen(useOldFlag),
          Effect.andThen(useOldFlag),
          Effect.andThen(Deferred.succeed(legacyRecorded, undefined)),
        ),
      );
      const current = command(
        "app:current",
        Deferred.succeed(currentStarted, undefined).pipe(Effect.andThen(Deferred.await(legacyRecorded))),
      );
      return yield* serve([legacy, current], (client) =>
        Effect.gen(function* () {
          // When: both calls are sent before either answers.
          const legacyCall = yield* client.sendRequest("tools/call", { name: "app:legacy", arguments: {} });
          const currentCall = yield* client.sendRequest("tools/call", { name: "app:current", arguments: {} });
          return { legacy: yield* legacyCall.response, current: yield* currentCall.response };
        }),
      );
    }),
  );

  // Then: only the call that used the flag lists it, once and without a use count.
  expect(deprecationsOf(responses.legacy)).toEqual([record]);
  expect(deprecationsOf(responses.current)).toEqual([]);
});

test("a later call neither inherits an earlier call's records nor loses its own repeat use", async () => {
  // Given: a session whose first call uses a deprecated flag.
  const entries = [command("app:legacy", useOldFlag), command("app:current", Effect.void)];

  // When: calls run one after another on the same retained runtime.
  const responses = await Effect.runPromise(
    serve(entries, (client) =>
      Effect.gen(function* () {
        const first = yield* client.request("tools/call", { name: "app:legacy", arguments: {} });
        const next = yield* client.request("tools/call", { name: "app:current", arguments: {} });
        const again = yield* client.request("tools/call", { name: "app:legacy", arguments: {} });
        return { first, next, again };
      }),
    ),
  );

  // Then: each envelope carries the uses of its own call only.
  expect(deprecationsOf(responses.first)).toEqual([record]);
  expect(deprecationsOf(responses.next)).toEqual([]);
  expect(deprecationsOf(responses.again)).toEqual([record]);
});

test("a call whose dispatch dies after the command used a deprecated surface still lists it", async () => {
  // Given: a command that uses a deprecated flag and whose result redaction hook throws.
  const legacy = command("app:legacy", useOldFlag);
  const dying: CommandEntry = {
    ...legacy,
    spec: {
      ...legacy.spec,
      redactionTokens: () => {
        throw new Error("redaction hook defect");
      },
    },
  };

  // When: an MCP client calls it.
  const response = await Effect.runPromise(
    serve([dying], (client) => client.request("tools/call", { name: "app:legacy", arguments: {} })),
  );

  // Then: the failure envelope still carries the call's deprecated use.
  const failed = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.Literal(true),
        structuredContent: Schema.Struct({
          ok: Schema.Literal(false),
          deprecations: Schema.Array(Schema.Unknown),
        }),
      }),
    }),
  )(response);
  expect(failed.result.structuredContent.deprecations).toEqual([record]);
});
