import { expect, test } from "bun:test";
import { CORE_VERSION } from "@lando/engine/version";
import { AppliedStateVersionError, ProviderUnavailableError, newerStateRemediation } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { stateCompatibilityDoctor } from "../../src/cli/commands/doctor-state-compatibility";

const providerId = ProviderId.make("test");
const path = AbsolutePath.make("/data/plugins/@lando/provider-test/applied-plans/app.json");

const run = (
  registry: ReturnType<typeof makeTestRuntimeProviderRegistry>,
  redact: (text: string) => string = (text) => text,
) =>
  Effect.runPromise(
    stateCompatibilityDoctor(redact).pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
  );

test("reports inventory unavailable without a registry", async () => {
  expect(await Effect.runPromise(stateCompatibilityDoctor((text) => text))).toMatchObject([
    { name: "applied-state-inventory", status: "warn" },
  ]);
});

test("passes when every provider inventory is clean", async () => {
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
    }),
  );
  expect(checks).toMatchObject([{ name: "state-compatibility", status: "pass", solutions: [] }]);
});

test("warns for newer applied state with writer and upgrade remediation", async () => {
  const writtenBy = "4.9.0";
  const issue = {
    reason: "newer-version" as const,
    path,
    appId: AppId.make("demo"),
    storedVersion: 99,
    supportedVersion: 11,
    writtenBy,
  };
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [issue] }),
    }),
  );
  const expected = newerStateRemediation({
    path,
    storedVersion: 99,
    supportedVersion: 11,
    writtenBy,
    reader: CORE_VERSION,
  });
  expect(checks).toMatchObject([
    {
      name: "applied-state",
      status: "warn",
      recovery: "manual",
      subject: path,
      context: {
        providerId,
        path,
        reason: "newer-version",
        appId: "demo",
        storedVersion: "99",
        supportedVersion: "11",
        writtenBy,
      },
      solutions: [{ kind: "manual", description: expected }],
    },
  ]);
});

test("warns for damaged applied state without inventing a writer", async () => {
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () =>
        Effect.succeed({
          plans: [],
          unreadable: [{ reason: "unreadable", path }],
        }),
    }),
  );
  expect(checks).toMatchObject([
    {
      name: "applied-state",
      status: "warn",
      recovery: "manual",
      subject: path,
      context: { providerId, path, reason: "unreadable" },
    },
  ]);
  expect(checks[0]?.context).not.toHaveProperty("writtenBy");
  expect(checks[0]?.solutions[0]?.description).toContain("could not be read");
});

test("redacts private paths in protected findings", async () => {
  const secret = "/secret-root/applied-plans/app.json";
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () =>
        Effect.succeed({
          plans: [],
          unreadable: [
            {
              reason: "newer-version",
              path: secret,
              storedVersion: 12,
              supportedVersion: 11,
              writtenBy: "4.8.0",
            },
          ],
        }),
    }),
    (text) => text.replaceAll("/secret-root", "[redacted]"),
  );
  expect(JSON.stringify(checks)).not.toContain("/secret-root");
  expect(checks[0]?.subject).toBe("[redacted]/applied-plans/app.json");
});

test("reports incomplete inventory without failing the section", async () => {
  const error = new ProviderUnavailableError({
    providerId,
    operation: "appliedStateInventory",
    message: "Unable to list secret-path applied plans.",
    remediation: "Repair the provider plugin state directory and rerun lando doctor.",
  });
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () => Effect.fail(error),
    }),
    (text) => text.replaceAll("secret-path", "[redacted]"),
  );
  expect(checks).toMatchObject([
    {
      name: "applied-state-inventory",
      status: "warn",
      recovery: "manual",
      subject: providerId,
      context: { providerId, error: "Unable to list [redacted] applied plans." },
    },
  ]);
  expect(JSON.stringify(checks)).not.toContain("secret-path");
});

test("projects AppliedStateVersionError inventory failures as protected records", async () => {
  const writtenBy = "5.0.0";
  const failure = new AppliedStateVersionError({
    providerId,
    operation: "applied-state.list",
    path,
    storedVersion: 20,
    supportedVersion: 11,
    scope: "provider",
    message: "protected",
    remediation: "upgrade",
    writtenBy,
  });
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () => Effect.fail(failure),
    }),
  );
  expect(checks).toMatchObject([
    {
      name: "applied-state",
      status: "warn",
      context: {
        reason: "newer-version",
        path,
        storedVersion: "20",
        supportedVersion: "11",
        writtenBy,
      },
    },
  ]);
  expect(checks[0]?.solutions[0]?.description).toBe(
    newerStateRemediation({
      path,
      storedVersion: 20,
      supportedVersion: 11,
      writtenBy,
      reader: CORE_VERSION,
    }),
  );
});

test("reports provider list failures as inventory warnings", async () => {
  const error = new ProviderUnavailableError({
    providerId,
    operation: "list",
    message: "No runtime provider plugins are installed.",
    remediation: "Run lando setup, then rerun lando doctor.",
  });
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.fail(error),
    }),
  );
  expect(checks).toMatchObject([
    {
      name: "applied-state-inventory",
      status: "warn",
      context: { error: error.message },
      solutions: [{ kind: "manual", description: error.remediation }],
    },
  ]);
});

test("bounds protected findings and records truncation", async () => {
  const issues = Array.from({ length: 60 }, (_, index) => ({
    reason: "unreadable" as const,
    path: `/data/app-${index}.json`,
  }));
  const checks = await run(
    makeTestRuntimeProviderRegistry({
      list: Effect.succeed([providerId]),
      appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: issues }),
    }),
  );
  expect(checks.filter((check) => check.name === "applied-state")).toHaveLength(50);
  expect(checks.find((check) => check.name === "state-compatibility")).toMatchObject({
    status: "warn",
    context: { truncated: "true", limit: "50" },
  });
});
