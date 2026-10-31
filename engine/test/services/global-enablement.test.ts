import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";

import { GlobalAppError, StateStoreError } from "@lando/sdk/errors";
import { StateStore } from "@lando/sdk/services";

import {
  globalContributionEnabled,
  globalEnablementBucket,
  readGlobalEnablement,
  seedGlobalEnablement,
  selectGlobalContributions,
  withGlobalMutation,
} from "../../src/global-app/enablement.ts";
import type { PendingGlobalServiceContribution } from "../../src/services/global-services.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const contributions: readonly [
  PendingGlobalServiceContribution,
  PendingGlobalServiceContribution,
  PendingGlobalServiceContribution,
] = [
  { plugin: "@lando/mail", contribution: { id: "mailpit" } },
  { plugin: "@lando/mail", contribution: { id: "mailhog", enabledByDefault: false } },
  { plugin: "@lando/router", contribution: { id: "traefik" } },
];

describe("global contribution selection", () => {
  test("selects one contribution or all contributions of an exact package", async () => {
    const ids = async (selector?: string) =>
      (await Effect.runPromise(selectGlobalContributions(contributions, selector))).map(
        (entry) => entry.contribution.id,
      );
    expect(await ids("mailhog")).toEqual(["mailhog"]);
    expect(await ids("@lando/mail")).toEqual(["mailpit", "mailhog"]);
    expect(await ids()).toEqual(["mailpit", "mailhog", "traefik"]);
    for (const selector of ["mail", "", "unknown"]) {
      const result = await Effect.runPromise(
        Effect.result(selectGlobalContributions(contributions, selector)),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(GlobalAppError);
    }
  });

  test("rejects a package/id ambiguity unless both names select the same contribution", async () => {
    const ambiguous = [...contributions, { plugin: "mailpit", contribution: { id: "other-mail" } }];
    const result = await Effect.runPromise(Effect.result(selectGlobalContributions(ambiguous, "mailpit")));
    expect(result._tag).toBe("Failure");
    expect(
      await Effect.runPromise(
        selectGlobalContributions([{ plugin: "mailpit", contribution: { id: "mailpit" } }], "mailpit"),
      ),
    ).toHaveLength(1);
  });
});

describe("persistent global enablement", () => {
  test("snapshots defaults once, preserves removed ids, and explicitly re-enables selections", async () => {
    const state = makeTestStateStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* readGlobalEnablement()).toEqual({});
        expect(yield* seedGlobalEnablement(contributions)).toEqual({
          mailpit: true,
          mailhog: false,
          traefik: true,
        });
        yield* seedGlobalEnablement(contributions, { ids: ["mailpit"], enabled: false });
        const upgraded = contributions.map((entry) => ({
          ...entry,
          contribution: { ...entry.contribution, enabledByDefault: !entry.contribution.enabledByDefault },
        }));
        expect(yield* seedGlobalEnablement(upgraded)).toEqual({
          mailpit: false,
          mailhog: false,
          traefik: true,
        });
        yield* seedGlobalEnablement([], { ids: ["removed-plugin"], enabled: false });
        return yield* seedGlobalEnablement(contributions, { ids: ["mailhog"], enabled: true });
      }).pipe(Effect.provide(state.layer)),
    );
    expect(result).toEqual({ mailpit: false, mailhog: true, traefik: true, "removed-plugin": false });
    expect(globalContributionEnabled(contributions[0], result)).toBe(false);
    expect(globalContributionEnabled(contributions[1], result)).toBe(true);
    expect(globalContributionEnabled(contributions[0], {})).toBe(true);
    expect(globalContributionEnabled(contributions[1], {})).toBe(false);
    const raw = [...state.snapshot().values()][0];
    expect(Bun.YAML.parse(new TextDecoder().decode(raw))).toEqual(result);
  });

  test.each(["mailpit: nope\n", "mailpit: { enabled: false }\n", "- false\n", "mailpit: [\n", "null\n"])(
    "rejects malformed enablement without replacing or quarantining it: %s",
    async (raw) => {
      const state = makeTestStateStore();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bucket = yield* globalEnablementBucket();
          yield* state.writeRaw(bucket.path, raw);
          const read = yield* Effect.result(readGlobalEnablement());
          const update = yield* Effect.result(seedGlobalEnablement(contributions));
          expect(read._tag).toBe("Failure");
          expect(update._tag).toBe("Failure");
          if (read._tag === "Failure") expect(read.failure).toBeInstanceOf(GlobalAppError);
          return yield* state.readRaw(bucket.path);
        }).pipe(Effect.provide(state.layer)),
      );
      expect(new TextDecoder().decode(result ?? undefined)).toBe(raw);
      expect(state.snapshot().size).toBe(1);
    },
  );

  test("concurrent updates preserve independent selections", async () => {
    const state = makeTestStateStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.all(
          [
            seedGlobalEnablement(contributions, { ids: ["mailpit"], enabled: false }),
            seedGlobalEnablement(contributions, { ids: ["mailhog"], enabled: true }),
          ],
          { concurrency: "unbounded" },
        );
        return yield* readGlobalEnablement();
      }).pipe(Effect.provide(state.layer)),
    );
    expect(result).toEqual({ mailpit: false, mailhog: true, traefik: true });
  });

  test("treats prototype-shaped contribution ids as ordinary own entries", async () => {
    const state = makeTestStateStore();
    const result = await Effect.runPromise(
      seedGlobalEnablement([{ plugin: "example", contribution: { id: "__proto__" } }]).pipe(
        Effect.provide(state.layer),
      ),
    );
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toBe(true);
    expect(globalContributionEnabled({ plugin: "example", contribution: { id: "constructor" } }, {})).toBe(
      true,
    );
  });
});

describe("global mutation serialization", () => {
  test("nested mutations retain caller services and acquire one lock", async () => {
    class CallerValue extends Context.Service<CallerValue, { readonly value: string }>()(
      "test/CallerValue",
    ) {}
    const state = makeTestStateStore();
    let acquisitions = 0;
    const store = StateStore.of({
      ...state.service,
      withLock: (key, body) => {
        acquisitions++;
        return state.service.withLock(key, body);
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const captured = yield* Effect.context<CallerValue | StateStore>();
        return yield* withGlobalMutation(
          withGlobalMutation(Effect.map(CallerValue, (caller) => caller.value)).pipe(
            Effect.provide(captured),
          ),
        );
      }).pipe(
        Effect.provideService(StateStore, store),
        Effect.provideService(CallerValue, { value: "caller" }),
      ),
    );
    expect(result).toBe("caller");
    expect(acquisitions).toBe(1);
  });

  test("concurrent mutation scopes do not interleave", async () => {
    const state = makeTestStateStore();
    const sequence: string[] = [];
    const operation = (id: string) =>
      withGlobalMutation(
        Effect.gen(function* () {
          sequence.push(`${id}:begin`);
          yield* Effect.yieldNow;
          sequence.push(`${id}:end`);
        }),
      );
    await Effect.runPromise(
      Effect.all([operation("first"), operation("second")], { concurrency: "unbounded" }).pipe(
        Effect.provide(state.layer),
      ),
    );
    expect(sequence).toEqual(["first:begin", "first:end", "second:begin", "second:end"]);
  });

  test("lock failures return GlobalAppError and body failures retain their identity", async () => {
    const state = makeTestStateStore();
    const store = StateStore.of({
      ...state.service,
      withLock: () =>
        Effect.fail(
          new StateStoreError({
            reason: "lock",
            operation: "withLock",
            path: "/private/lock",
            remediation: "Retry after the other command exits.",
          }),
        ),
    });
    const lockResult = await Effect.runPromise(
      Effect.result(withGlobalMutation(Effect.void)).pipe(Effect.provideService(StateStore, store)),
    );
    expect(lockResult._tag).toBe("Failure");
    if (lockResult._tag === "Failure") expect(lockResult.failure).toBeInstanceOf(GlobalAppError);
    const bodyFailure = new GlobalAppError({
      message: "body",
      operation: "start",
      remediation: "Fix the service and retry.",
    });
    const bodyResult = await Effect.runPromise(
      Effect.result(withGlobalMutation(Effect.fail(bodyFailure))).pipe(Effect.provide(state.layer)),
    );
    expect(bodyResult._tag).toBe("Failure");
    if (bodyResult._tag === "Failure") expect(bodyResult.failure).toBe(bodyFailure);
  });
});
