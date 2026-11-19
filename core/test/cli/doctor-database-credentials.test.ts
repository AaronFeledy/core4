import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Resolver from "@lando/engine/services/environment-value-resolver";
import * as Secrets from "@lando/engine/services/secret-store";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortNumber,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Deferred, Duration, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { databaseCredentialsDoctorChecks } from "../../src/cli/commands/doctor-database-credentials";
import { withCwd } from "../_support/temp-cwd";
import { listenerRegistry } from "./doctor-listeners-fixture";

const encoder = new TextEncoder();
const stderr = (text: string) => ({ kind: "stderr" as const, chunk: encoder.encode(text) });
const exit = (code: number) => ({ exitCode: code });

const planFor = async (): Promise<{ plan: AppPlan; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-db-creds-"));
  const appRoot = AbsolutePath.make(await realpath(root));
  const identity = { appRoot, ownerKey: appIdentityKey("owner", appRoot) };
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    source: "test",
    runtime: 4 as const,
  };
  const service: ServicePlan = {
    name: ServiceName.make("db"),
    type: "mariadb",
    provider: ProviderId.make("docker"),
    primary: true,
    environment: {},
    mounts: [],
    endpoints: [{ kind: "internal", protocol: "tcp", port: 3306, primary: true }],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    extensions: {},
    metadata,
    connection: {
      family: "mariadb",
      port: PortNumber.make(3306),
      creds: { user: "lando", password: "original", database: "appdb", rootPassword: "rootpass" },
    },
  };
  return {
    root,
    plan: {
      valueModel: 1,
      id: AppId.make("creds-demo"),
      name: "creds-demo",
      slug: "creds-demo",
      root: identity.appRoot,
      identity,
      provider: service.provider,
      services: { [service.name]: service },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    },
  };
};

const providerWith = (plan: AppPlan, overrides: Partial<RuntimeProviderShape>): RuntimeProviderShape => ({
  ...TestRuntimeProvider,
  id: String(plan.provider),
  displayName: "Applied Docker",
  version: "1.0.0",
  list: () =>
    Effect.succeed(
      Object.values(plan.services).map((service) => ({
        app: plan.id,
        service: service.name,
        providerId: plan.provider,
        status: "running" as const,
        containerId: `container-${service.name}`,
        publications: { status: "unknown" as const },
      })),
    ),
  ...overrides,
});

const layers = (plan: AppPlan, provider: RuntimeProviderShape) => {
  const redaction = Layer.succeed(RedactionService, makeRedactionService());
  return Layer.mergeAll(
    listenerRegistry(plan, provider),
    Resolver.layer.pipe(Layer.provideMerge(Layer.merge(redaction, Secrets.layerWith({ env: {} })))),
  );
};

const collect = async (plan: AppPlan, provider: RuntimeProviderShape, root: string, budgetMs = 5_000) =>
  withCwd(
    root,
    () =>
      Effect.runPromise(
        databaseCredentialsDoctorChecks({ budgetMs, redact: (value) => value }).pipe(
          Effect.provide(layers(plan, provider)),
        ),
      ),
    [root],
  );

test("skips database credentials on the idle provider holding the applied app", async () => {
  const { plan, root } = await planFor();
  try {
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "idle" }),
      execStream: () => Stream.die("idle checks must not exec"),
    });
    const result = await collect(plan, provider, root);
    expect(result.checks).toEqual([]);
    expect(result.skipped).toMatchObject([{ reason: expect.stringContaining("idle") }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a rejected login as a warn finding with recovery advice", async () => {
  const { plan, root } = await planFor();
  try {
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      execStream: (_target, spec) =>
        spec.env?.MYSQL_PWD === "rootpass"
          ? Stream.make({ exitCode: 0 })
          : Stream.make(
              stderr(
                "ERROR 1045 (28000): Access denied for user 'lando'@'127.0.0.1' (using password: YES)\n",
              ),
              exit(1),
            ),
    });
    const result = await collect(plan, provider, root);
    const warning = result.checks.find((check) => check.status === "warn");
    expect(warning).toMatchObject({
      name: "database-credentials",
      subject: "creds-demo/db:app",
      severity: "warn",
      context: { family: "mariadb", login: "app" },
    });
    expect(warning?.solutions[0]?.description).toContain("Restore the previous creds values");
    expect(JSON.stringify(result)).not.toContain("original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes when the running service accepts the configured login", async () => {
  const { plan, root } = await planFor();
  try {
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      execStream: () => Stream.make({ exitCode: 0 }),
    });
    const result = await collect(plan, provider, root);
    expect(result.checks.filter((check) => check.status === "pass")).toHaveLength(2);
    expect(result.skipped).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips a stopped service instead of reporting its credentials", async () => {
  const { plan, root } = await planFor();
  try {
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      list: () => Effect.succeed([]),
      execStream: () => Stream.die("stopped services must not exec"),
    });
    const result = await collect(plan, provider, root);
    expect(result.checks).toEqual([]);
    expect(result.skipped).toMatchObject([
      { check: "database-credentials:db", reason: expect.stringContaining("not running") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips an unverified login without turning it into a finding", async () => {
  const { plan, root } = await planFor();
  try {
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      execStream: () => Stream.make(stderr("mariadb: not found\n"), exit(127)),
    });
    const result = await collect(plan, provider, root);
    expect(result.checks).toEqual([]);
    expect(result.skipped).toMatchObject([
      { check: "database-credentials:db:app", reason: expect.stringContaining("unverified") },
      { check: "database-credentials:db:root", reason: expect.stringContaining("unverified") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips every running database service when the environment session is unavailable", async () => {
  const { plan, root } = await planFor();
  try {
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      execStream: () => Stream.die("an unavailable session must not exec"),
    });
    const result = await withCwd(
      root,
      () =>
        Effect.runPromise(
          databaseCredentialsDoctorChecks({ budgetMs: 5_000, redact: (value) => value }).pipe(
            Effect.provide(
              Layer.mergeAll(
                listenerRegistry(plan, provider),
                Layer.succeed(RedactionService, makeRedactionService()),
              ),
            ),
          ),
        ),
      [root],
    );
    expect(result.checks).toEqual([]);
    expect(result.skipped).toMatchObject([
      { check: "database-credentials:db", reason: expect.stringContaining("environment session") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a check the section budget outran as an explicit skip per login", async () => {
  const { plan, root } = await planFor();
  try {
    // The section's own budget is four times the check's, so the check expires first and its
    // per-login verdicts are what reach the report instead of one lost section.
    const provider = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      execStream: () => Stream.never,
    });
    const result = await collect(plan, provider, root, 2_000);
    expect(result.checks).toEqual([]);
    expect(result.skipped).toMatchObject([
      { check: "database-credentials:db:app", reason: expect.stringContaining("budget expired") },
      { check: "database-credentials:db:root", reason: expect.stringContaining("budget expired") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Effect 4's TestClock fires every due sleep in one `adjust`, yielding only once between them,
 * so work woken by an earlier deadline cannot settle before a later deadline fires. Advance a
 * millisecond at a time and drain the scheduler between steps, as a real clock would.
 */
const advanceSettled = Effect.fnUntraced(function* (millis: number) {
  for (let elapsed = 0; elapsed < millis; elapsed += 1) {
    yield* TestClock.adjust("1 millis");
    yield* Effect.promise(() => new Promise<void>((resume) => setImmediate(resume)));
  }
});

test("keeps a completed rejection when slow target work spends most of the section budget", async () => {
  const { plan, root } = await planFor();
  try {
    const base = providerWith(plan, {
      getStatus: Effect.succeed({ state: "running" }),
      // The app login is rejected at once; the administrator login never answers.
      execStream: (_target, spec) =>
        spec.env?.MYSQL_PWD === "rootpass"
          ? Stream.never
          : Stream.make(
              stderr(
                "ERROR 1045 (28000): Access denied for user 'lando'@'127.0.0.1' (using password: YES)\n",
              ),
              exit(1),
            ),
    });
    const listing = Effect.runSync(Deferred.make<void>());
    const provider = {
      ...base,
      // Observing the applied app and listing its services happens before any login check starts.
      list: () =>
        Effect.andThen(Deferred.succeed(listing, undefined), Effect.sleep(Duration.millis(1_600))).pipe(
          Effect.andThen(base.list({ app: plan.id })),
        ),
    };
    const result = await withCwd(
      root,
      () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              databaseCredentialsDoctorChecks({ budgetMs: 2_000, redact: (value) => value }).pipe(
                Effect.provide(layers(plan, provider)),
              ),
            );
            // The listing consumes 1,600ms of the 2,000ms section budget; the check's own budget
            // must be derived from the 400ms that remain, not from the section's full duration.
            yield* Deferred.await(listing);
            yield* TestClock.adjust(Duration.millis(1_600));
            yield* advanceSettled(400);
            return yield* Fiber.join(fiber);
          }).pipe(Effect.provide(TestClock.layer())),
        ),
      [root],
    );
    const warning = result.checks.find((check) => check.status === "warn");
    expect(warning).toMatchObject({
      name: "database-credentials",
      subject: "creds-demo/db:app",
      context: { family: "mariadb", login: "app" },
    });
    expect(result.skipped ?? []).not.toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("could not complete") }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
