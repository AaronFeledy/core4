import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";

import {
  commitGlobalPolicy,
  emptyGlobalPolicy,
  globalContributionPolicy,
  globalPolicyBucket,
  prepareGlobalPolicy,
  readGlobalPolicy,
} from "../../src/global-app/enablement.ts";
import type { PendingGlobalServiceContribution } from "../../src/services/global-services.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const contributions: ReadonlyArray<PendingGlobalServiceContribution> = [
  { plugin: "@example/mail", contribution: { id: "mailpit" } },
  { plugin: "@example/mail", contribution: { id: "mailhog", enabledByDefault: false } },
  { plugin: "@example/router", contribution: { id: "traefik" } },
];

const preference = (
  policy: Parameters<typeof globalContributionPolicy>[1],
  id: string,
  catalog = contributions,
) => {
  const entry = catalog.find((candidate) => candidate.contribution.id === id);
  if (entry === undefined) throw new Error(`Missing test contribution ${id}`);
  return globalContributionPolicy(entry, policy);
};

describe("owned global policy", () => {
  test("pins initial defaults and preserves their provenance when plugin defaults change", async () => {
    const first = await Effect.runPromise(prepareGlobalPolicy(emptyGlobalPolicy(), contributions));
    const upgraded = contributions.map((entry) => ({
      ...entry,
      contribution: { ...entry.contribution, enabledByDefault: !entry.contribution.enabledByDefault },
    }));
    const second = await Effect.runPromise(prepareGlobalPolicy(first.policy, upgraded));
    expect(first.policy.revision).toBe(1);
    expect(second.changed).toBe(false);
    expect(second.policy.revision).toBe(1);
    expect(preference(second.policy, "mailpit")).toEqual({ enabled: true, source: "default" });
    expect(preference(second.policy, "mailhog")).toEqual({ enabled: false, source: "default" });
  });

  test("a package stays disabled after it adds a new default-enabled contribution", async () => {
    const disabled = await Effect.runPromise(
      prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
        selectors: ["@example/mail"],
        enabled: false,
      }),
    );
    const upgraded = [...contributions, { plugin: "@example/mail", contribution: { id: "new-service" } }];
    const seeded = await Effect.runPromise(prepareGlobalPolicy(disabled.policy, upgraded));
    expect(disabled.ids).toEqual(["mailhog", "mailpit"]);
    expect(disabled.plugins).toEqual(["@example/mail"]);
    expect(preference(seeded.policy, "new-service", upgraded)).toEqual({ enabled: false, source: "plugin" });
    expect(preference(seeded.policy, "traefik", upgraded)).toEqual({ enabled: true, source: "default" });
  });

  test("explicit contribution choices override package policy and a package action clears exceptions", async () => {
    const disabled = await Effect.runPromise(
      prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
        selectors: ["@example/mail"],
        enabled: false,
      }),
    );
    const exception = await Effect.runPromise(
      prepareGlobalPolicy(disabled.policy, contributions, { selectors: ["mailhog"], enabled: true }),
    );
    expect(preference(exception.policy, "mailhog")).toEqual({ enabled: true, source: "contribution" });
    expect(preference(exception.policy, "mailpit").enabled).toBe(false);
    const repeated = await Effect.runPromise(
      prepareGlobalPolicy(exception.policy, contributions, { selectors: ["@example/mail"], enabled: false }),
    );
    expect(preference(repeated.policy, "mailhog")).toEqual({ enabled: false, source: "plugin" });
    expect(repeated.policy.plugins["@example/mail"]?.contributions.mailhog).not.toHaveProperty("enabled");
    const enabled = await Effect.runPromise(
      prepareGlobalPolicy(repeated.policy, contributions, { selectors: ["@example/mail"], enabled: true }),
    );
    expect(preference(enabled.policy, "mailhog")).toEqual({ enabled: true, source: "plugin" });
  });

  test("retained package actions clear retained exceptions without claiming current custom service ids", async () => {
    const disabled = await Effect.runPromise(
      prepareGlobalPolicy(emptyGlobalPolicy(), contributions, { selectors: ["mailpit"], enabled: false }),
    );
    const absent = await Effect.runPromise(
      prepareGlobalPolicy(disabled.policy, [], { selectors: ["@example/mail"], enabled: true }),
    );
    expect(absent.ids).toEqual([]);
    expect(absent.selections).toEqual([
      { plugin: "@example/mail", id: "mailhog" },
      { plugin: "@example/mail", id: "mailpit" },
    ]);
    expect(absent.policy.plugins["@example/mail"]?.contributions.mailpit).not.toHaveProperty("enabled");
    const replacement = { plugin: "@example/replacement", contribution: { id: "mailpit" } };
    expect(globalContributionPolicy(replacement, disabled.policy)).toEqual({
      enabled: true,
      source: "default",
    });
  });

  test("explicit repeated selectors deduplicate and --all acts on packages including retained policy", async () => {
    const selected = await Effect.runPromise(
      prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
        selectors: ["mailpit", "traefik", "mailpit"],
        enabled: false,
      }),
    );
    expect(selected.ids).toEqual(["mailpit", "traefik"]);
    const all = await Effect.runPromise(
      prepareGlobalPolicy(selected.policy, [], { selectors: [], all: true, enabled: false }),
    );
    expect(all.plugins).toEqual(["@example/mail", "@example/router"]);
    expect(all.policy.plugins["@example/router"]?.enabled).toBe(false);
  });

  test.each([
    { selectors: [], enabled: false },
    { selectors: ["mailpit"], all: true, enabled: false },
    { selectors: [""], enabled: false },
    { selectors: ["mail"], enabled: false },
  ])("rejects missing, mixed, empty and guessed selections: %j", async (change) => {
    const result = await Effect.runPromise(
      Effect.result(prepareGlobalPolicy(emptyGlobalPolicy(), contributions, change)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(GlobalAppError);
  });

  test("rejects package/id ambiguity and current/retained owner ambiguity", async () => {
    const ambiguous = [...contributions, { plugin: "mailpit", contribution: { id: "other" } }];
    const packageResult = await Effect.runPromise(
      Effect.result(
        prepareGlobalPolicy(emptyGlobalPolicy(), ambiguous, { selectors: ["mailpit"], enabled: false }),
      ),
    );
    expect(packageResult._tag).toBe("Failure");
    const old = await Effect.runPromise(prepareGlobalPolicy(emptyGlobalPolicy(), contributions));
    const replacement = [{ plugin: "@example/replacement", contribution: { id: "mailpit" } }];
    const ownerResult = await Effect.runPromise(
      Effect.result(prepareGlobalPolicy(old.policy, replacement, { selectors: ["mailpit"], enabled: false })),
    );
    expect(ownerResult._tag).toBe("Failure");
    const exactPackage = await Effect.runPromise(
      prepareGlobalPolicy(old.policy, replacement, { selectors: ["@example/replacement"], enabled: false }),
    );
    expect(exactPackage.ids).toEqual(["mailpit"]);
    expect(exactPackage.selections).toEqual([{ plugin: "@example/replacement", id: "mailpit" }]);
  });

  test("revision exhaustion fails rather than reusing an imprecise number", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(prepareGlobalPolicy({ revision: Number.MAX_SAFE_INTEGER, plugins: {} }, contributions)),
    );
    expect(outcome._tag).toBe("Failure");
  });

  test("prototype-shaped plugin and contribution ids remain ordinary owned entries", async () => {
    const entry = { plugin: "__proto__", contribution: { id: "constructor" } };
    const prepared = await Effect.runPromise(
      prepareGlobalPolicy(emptyGlobalPolicy(), [entry], { selectors: ["__proto__"], enabled: false }),
    );
    expect(Object.hasOwn(prepared.policy.plugins, "__proto__")).toBe(true);
    expect(globalContributionPolicy(entry, prepared.policy)).toEqual({ enabled: false, source: "plugin" });
  });
});

describe("policy persistence and preflight revisions", () => {
  test("commits only the preflighted revision and leaves a competing writer intact", async () => {
    const state = makeTestStateStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
          selectors: ["mailpit"],
          enabled: false,
        });
        const competing = yield* prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
          selectors: ["traefik"],
          enabled: false,
        });
        yield* commitGlobalPolicy(0, first.policy);
        const rejected = yield* Effect.result(commitGlobalPolicy(0, competing.policy));
        expect(rejected._tag).toBe("Failure");
        const current = yield* readGlobalPolicy();
        expect(current).toEqual(first.policy);
        const retry = yield* prepareGlobalPolicy(current, contributions, {
          selectors: ["traefik"],
          enabled: false,
        });
        const committed = yield* commitGlobalPolicy(current.revision, retry.policy);
        expect(committed.revision).toBe(2);
        expect(preference(committed, "mailpit").enabled).toBe(false);
        expect(preference(committed, "traefik").enabled).toBe(false);
      }).pipe(Effect.provide(state.layer)),
    );
  });

  test("rejects a changed candidate that did not advance its revision", async () => {
    const state = makeTestStateStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* prepareGlobalPolicy(emptyGlobalPolicy(), contributions);
        const invalid = { ...prepared.policy, revision: 0 };
        const rejected = yield* Effect.result(commitGlobalPolicy(0, invalid));
        expect(rejected._tag).toBe("Failure");
        expect(yield* readGlobalPolicy()).toEqual(emptyGlobalPolicy());
      }).pipe(Effect.provide(state.layer)),
    );
  });

  test("concurrent candidates cannot both commit the same preflight revision", async () => {
    const state = makeTestStateStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
          selectors: ["mailpit"],
          enabled: false,
        });
        const b = yield* prepareGlobalPolicy(emptyGlobalPolicy(), contributions, {
          selectors: ["traefik"],
          enabled: false,
        });
        return yield* Effect.all(
          [Effect.result(commitGlobalPolicy(0, a.policy)), Effect.result(commitGlobalPolicy(0, b.policy))],
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(state.layer)),
    );
    expect(result.filter((entry) => entry._tag === "Success")).toHaveLength(1);
    expect(result.filter((entry) => entry._tag === "Failure")).toHaveLength(1);
  });

  test("an unchanged action preserves revision and stored bytes", async () => {
    const state = makeTestStateStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* prepareGlobalPolicy(emptyGlobalPolicy(), contributions);
        yield* commitGlobalPolicy(0, prepared.policy);
        const before = [...state.snapshot().values()][0];
        const repeat = yield* prepareGlobalPolicy(prepared.policy, contributions);
        expect(repeat.changed).toBe(false);
        yield* commitGlobalPolicy(prepared.policy.revision, repeat.policy);
        expect([...state.snapshot().values()][0]).toEqual(before);
        const bucket = yield* globalPolicyBucket();
        expect(Bun.YAML.parse(new TextDecoder().decode(before))).toEqual(yield* bucket.get);
      }).pipe(Effect.provide(state.layer)),
    );
  });

  test.each([
    "mailpit: false\n",
    "revision: -1\nplugins: {}\n",
    "revision: 0\nplugins:\n  owner:\n    enabled: nope\n    contributions: {}\n",
    "revision: 0\nplugins:\n  owner:\n    contributions:\n      mailpit:\n        defaultEnabled: true\n        unexpected: true\n",
    "revision: 0\nplugins: [\n",
    "null\n",
  ])("fails closed on malformed owned policy without replacing it: %s", async (raw) => {
    const state = makeTestStateStore();
    await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* globalPolicyBucket();
        yield* state.writeRaw(bucket.path, raw);
        const result = yield* Effect.result(readGlobalPolicy());
        expect(result._tag).toBe("Failure");
        expect(new TextDecoder().decode((yield* state.readRaw(bucket.path)) ?? undefined)).toBe(raw);
        expect(state.snapshot().size).toBe(1);
      }).pipe(Effect.provide(state.layer)),
    );
  });
});
