import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { PluginManifestError } from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";

import {
  type SubscriberIndex,
  makeSubscriberRegistrationClosure,
} from "../../src/lifecycle/subscriber-index.ts";

const manifest = (input: {
  readonly name?: string;
  readonly commands?: ReadonlyArray<string>;
  readonly subscribers: ReadonlyArray<Record<string, unknown>>;
}) =>
  Schema.decodeUnknownSync(PluginManifest)({
    name: input.name ?? "@example/subscribers",
    version: "1.0.0",
    api: 4,
    ...(input.commands === undefined ? {} : { contributes: { commands: input.commands } }),
    subscribers: input.subscribers,
  });

const ids = (index: SubscriberIndex, eventName: string) =>
  index.forEvent(eventName).map((subscriber) => subscriber.entry.id);

describe("symbolic subscriber index", () => {
  test("matches a newly seen app command family without a command catalog", async () => {
    // Given: a terminal-family subscriber and no app command metadata.
    const closure = makeSubscriberRegistrationClosure([
      manifest({
        subscribers: [
          { id: "terminal", selectors: [{ family: "cli-command-terminal" }], module: "./terminal.ts" },
        ],
      }),
    ]);

    // When: registration closes over a complete catalog that predates a later command.
    const index = await Effect.runPromise(closure.close({ appCommandIds: ["app:previous"] }));

    // Then: run and error match an app id that was never enumerated, and init does not.
    expect(ids(index, "cli-app:newly-seen-run")).toEqual(["terminal"]);
    expect(ids(index, "cli-app:newly-seen-error")).toEqual(["terminal"]);
    expect(ids(index, "cli-app:newly-seen-init")).toEqual([]);
    expect(index.subscribers.map((subscriber) => subscriber.entry.id)).toEqual(["terminal"]);
  });

  test("defers a syntactically valid unknown app selector until that event is emitted", async () => {
    // Given: an exact app selector whose id is absent from static metadata.
    const closure = makeSubscriberRegistrationClosure([
      manifest({
        subscribers: [
          { id: "exact", selectors: [{ event: "cli-app:unseen-script-run" }], module: "./exact.ts" },
        ],
      }),
    ]);

    // When: registration closes with no app catalog.
    const index = await Effect.runPromise(
      closure.close({ builtIns: ["app:start", "meta:version", "apps:list"] }),
    );

    // Then: only the real deferred invocation matches, and static neighbors are untouched.
    expect(ids(index, "cli-app:unseen-script-run")).toEqual(["exact"]);
    expect(ids(index, "cli-app:other-script-run")).toEqual([]);
    expect(ids(index, "cli-app:start-run")).toEqual([]);
  });

  test("treats a missing app catalog differently from an authoritative empty catalog", async () => {
    // Given: the same unknown app selector under two catalog states.
    const subscribers = [
      { id: "exact", selectors: [{ event: "cli-app:unseen-script-run" }], module: "./exact.ts" },
    ];

    // When: one closure omits the catalog and one supplies an empty authoritative catalog.
    const deferred = await Effect.runPromiseExit(
      makeSubscriberRegistrationClosure([manifest({ subscribers })]).close(),
    );
    const emptyCatalog = await Effect.runPromiseExit(
      makeSubscriberRegistrationClosure([manifest({ subscribers })]).close({ appCommandIds: [] }),
    );

    // Then: absence stays deferred, while an explicit empty catalog rejects the target.
    expect(Exit.isSuccess(deferred)).toBe(true);
    expect(Exit.isFailure(emptyCatalog)).toBe(true);
    if (Exit.isFailure(emptyCatalog)) {
      const failure = Cause.findErrorOption(emptyCatalog.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") expect(failure.value).toBeInstanceOf(PluginManifestError);
    }
  });

  test("accepts an app selector present in an authoritative catalog", async () => {
    // Given: an exact selector for an app command the caller has actually loaded.
    const closure = makeSubscriberRegistrationClosure([
      manifest({
        subscribers: [{ id: "exact", selectors: [{ event: "cli-app:release-run" }], module: "./exact.ts" }],
      }),
    ]);

    // When: registration closes with that id in the authoritative catalog.
    const index = await Effect.runPromise(closure.close({ appCommandIds: ["app:release"] }));

    // Then: the exact event matches.
    expect(ids(index, "cli-app:release-run")).toEqual(["exact"]);
  });

  test("rejects malformed, unknown static, and unknown plugin command selectors", async () => {
    // Given: selectors that are not deferred app bindings.
    const cases = [
      "cli-app:start",
      "cli-APP:start-run",
      "cli-app:task\n-run",
      "cli-app:task-run\n",
      "cli-app::task-run",
      "cli-app:task:-run",
      "cli-app:task name-run",
      "cli-app:-run",
      "cli-app:task-complete",
      "cli-app:*-run",
      "cli-meta:missing-run",
      "cli-apps:missing-run",
      "cli-example:missing-run",
      "invented-event",
    ];

    for (const event of cases) {
      // When: registration closes with static metadata that does not contain the target.
      const exit = await Effect.runPromiseExit(
        makeSubscriberRegistrationClosure([
          manifest({
            commands: ["example:release"],
            subscribers: [{ id: "bad", selectors: [{ event }], module: "./bad.ts" }],
          }),
        ]).close({ builtIns: ["meta:version", "apps:list", "app:start"] }),
      );

      // Then: registration fails and publishes no index.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(PluginManifestError);
          expect(failure.value.message).toContain(event);
        }
      }
    }
  });

  test("accepts an exact selector for a plugin-contributed command without a command registry", async () => {
    // Given: a plugin manifest that contributes the selected command.
    const closure = makeSubscriberRegistrationClosure([
      manifest({
        commands: ["example:release"],
        subscribers: [
          { id: "exact", selectors: [{ event: "cli-example:release-run" }], module: "./exact.ts" },
        ],
      }),
    ]);

    // When: registration closes from manifest metadata alone.
    const index = await Effect.runPromise(closure.close());

    // Then: the contributed command is an exact match.
    expect(ids(index, "cli-example:release-run")).toEqual(["exact"]);
  });

  test.each(["standalone", "Example:release.v2"])(
    "honors static catalog membership before deferred syntax for %s",
    async (commandId) => {
      // Given: a manifest command whose identity is not constrained by a command-id schema.
      const closure = makeSubscriberRegistrationClosure([
        manifest({
          commands: [commandId],
          subscribers: [
            { id: "exact", selectors: [{ event: `cli-${commandId}-init` }], module: "./exact.ts" },
            { id: "terminal", selectors: [{ family: "cli-command-terminal" }], module: "./terminal.ts" },
          ],
        }),
      ]);
      // When: registration closes from authoritative manifest metadata.
      const index = await Effect.runPromise(closure.close());
      // Then: exact init and both terminal-family phases honor the known identity.
      expect(ids(index, `cli-${commandId}-init`)).toEqual(["exact"]);
      expect(ids(index, `cli-${commandId}-run`)).toEqual(["terminal"]);
      expect(ids(index, `cli-${commandId}-error`)).toEqual(["terminal"]);
    },
  );

  test("dispatches an overlapping exact and family subscriber once in priority order", async () => {
    // Given: one subscriber selected by both family and exact selectors, beside a later equal-priority subscriber.
    const closure = makeSubscriberRegistrationClosure([
      manifest({
        subscribers: [
          {
            id: "later",
            selectors: [{ event: "cli-app:start-run" }],
            module: "./later.ts",
            priority: 200,
          },
          {
            id: "overlap",
            selectors: [
              { family: "cli-command-terminal" },
              { event: "cli-app:start-run" },
              { family: "cli-command-terminal" },
              { event: "cli-app:start-run" },
            ],
            module: "./overlap.ts",
            priority: 100,
          },
          {
            id: "next",
            selectors: [{ event: "cli-app:start-run" }],
            module: "./next.ts",
            priority: 100,
          },
        ],
      }),
    ]);

    // When: registration closes without enumerating app:start.
    const index = await Effect.runPromise(closure.close());

    // Then: priority order is stable and the overlap is delivered once, including on a different terminal event.
    expect(ids(index, "cli-app:start-run")).toEqual(["overlap", "next", "later"]);
    expect(ids(index, "cli-app:other-error")).toEqual(["overlap"]);
    expect(ids(index, "cli-app:start-init")).toEqual([]);
  });
});
