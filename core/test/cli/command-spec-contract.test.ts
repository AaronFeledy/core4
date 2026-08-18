import { expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import type { LandoCommandSpec } from "../../src/cli/spec/command-spec.ts";

type Extends<A, B> = [A] extends [B] ? true : false;
type ExpectFalse<T extends false> = T;

test("keeps LandoCommandSpec namespace narrowed to core namespaces", () => {
  // Given — built-in specs must not accept a plugin cspace topic
  type BuiltInWithCspace = {
    readonly id: "db:import";
    readonly summary: "nope";
    readonly namespace: "db";
    readonly bootstrap: "app";
    readonly run: (input: never) => Effect.Effect<void, never, never>;
    readonly resultSchema: typeof Schema.Unknown;
  };
  const builtInRejectsCspace: ExpectFalse<Extends<BuiltInWithCspace, LandoCommandSpec>> = false;

  const builtIn: LandoCommandSpec = {
    id: "app:start",
    summary: "Start the current Lando app.",
    namespace: "app",
    bootstrap: "app",
    resultSchema: Schema.Unknown,
    run: () => Effect.void,
  };

  // When
  const rendered = builtIn.render?.({ ok: true }, undefined, undefined);

  // Then — core string render remains on LandoCommandSpec only
  expect(builtInRejectsCspace).toBe(false);
  expect(builtIn.namespace).toBe("app");
  expect(rendered).toBeUndefined();
});
