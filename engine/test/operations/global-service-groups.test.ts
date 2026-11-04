import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { GlobalAppError, ServiceStartError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  DEBUGGER_HOST_ALIAS,
  GlobalConfig,
  HOST_GATEWAY_TARGET,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  type ApplyOptions,
  ConfigService,
  EnvironmentValueResolver,
  GlobalAppService,
  PathsService,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect";
import { withGlobalMutation } from "../../src/global-app/mutation.ts";
import { readGlobalConsumerReservations } from "../../src/operations/global-consumer-lease.ts";
import {
  applyGlobalServiceGroups as applyGlobalServiceGroupsEffect,
  globalServiceGroupError,
} from "../../src/operations/global-service-groups.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";

const directory = mkdtempSync(join(tmpdir(), "lando-global-groups-"));
const root = AbsolutePath.make(join(directory, "global"));
mkdirSync(root);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const leaseLayer = Layer.mergeAll(
  makeTestStateStore().layer,
  testEnvironmentResolverLayer,
  BunFileSystem.layer,
  PrivateFileAccessService.layer,
  Layer.succeed(
    PathsService,
    makeLandoPaths({
      userDataRoot: directory,
      userConfRoot: join(directory, "conf"),
      userCacheRoot: join(directory, "cache"),
      systemPluginRoot: join(directory, "plugins"),
      env: {},
      platform: "linux",
    }),
  ),
  Layer.succeed(
    GlobalAppService,
    GlobalAppService.of({
      id: "global",
      providerId: Effect.succeed(ProviderId.make("lando")),
      root: Effect.succeed(root),
      paths: Effect.succeed({
        root,
        distLandofile: AbsolutePath.make(join(root, ".lando.dist.yml")),
        userLandofile: AbsolutePath.make(join(root, ".lando.yml")),
      }),
      ensureRoot: Effect.void,
      ensureUserLandofile: Effect.die("unused"),
      ensureRunning: () => Effect.die("unused"),
      regenerateDist: () => Effect.die("unused"),
    }),
  ),
);
const applyGlobalServiceGroups = <E, R, AdmissionE = never, AdmissionR = never>(
  ...args: Parameters<typeof applyGlobalServiceGroupsEffect<E, R, AdmissionE, AdmissionR>>
) => withGlobalMutation(applyGlobalServiceGroupsEffect(...args)).pipe(Effect.provide(leaseLayer));

const globalPlan: AppPlan = {
  id: AppId.make("global"),
  name: "global",
  slug: "global",
  root,
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};

const service = (name: string, dependencies: ReadonlyArray<string> = []): ServicePlan => ({
  type: "test",
  provider: globalPlan.provider,
  primary: true,
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  hostAliases: [],
  metadata: globalPlan.metadata,
  extensions: {},
  name: ServiceName.make(name),
  artifact: { kind: "ref", ref: `unbuilt:${name}` },
  dependsOn: dependencies.map((name) => ({
    service: ServiceName.make(name),
    condition: "service_started",
    required: true,
  })),
});
const planWith = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  ...globalPlan,
  services: Object.fromEntries(services.map((service) => [service.name, service])),
});
const build = (plan: AppPlan) =>
  Effect.succeed({
    ...plan,
    services: Object.fromEntries(
      Object.values(plan.services).map((service) => [
        service.name,
        { ...service, artifact: { kind: "ref" as const, ref: `built:${service.name}` } },
      ]),
    ),
  });
const failure = (name: string, remediation?: string) =>
  new ServiceStartError({
    service: name,
    providerId: "lando",
    operation: "apply",
    message: `Cannot start ${name}`,
    remediation:
      remediation ??
      `Inspect \`lando logs -s ${name}\`, fix the service configuration or image, and start the app again.`,
  });
const refs = (plan: AppPlan) => Object.values(plan.services).map((service) => service.artifact);

describe("global service groups", () => {
  test("a failed group retains its created containers and leaves successful groups running", async () => {
    const plan = planWith([service("working"), service("broken"), service("later")]);
    const created = new Set<string>();
    const cleanup: string[] = [];
    const error = failure("broken", "Repair the dependency and retry.");
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (group) =>
        Effect.gen(function* () {
          for (const name of Object.keys(group.services)) created.add(name);
          if (group.services[ServiceName.make("broken")] !== undefined) return yield* Effect.fail(error);
          return { changed: true };
        }),
      destroy: (target) =>
        Effect.sync(() => {
          cleanup.push(String(target.app));
          created.clear();
          return { kind: "destroyed" as const };
        }),
      stop: (target) =>
        Effect.sync(() => {
          cleanup.push(String(target.service));
        }),
    };
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        { provider, services: Object.values(plan.services), options: { reconcile: false } },
        build,
      ),
    );
    expect([...created]).toEqual(["working", "broken", "later"]);
    expect(cleanup).toEqual([]);
    expect(outcome.services.map((service) => String(service.name))).toEqual(["working", "later"]);
    expect(outcome.failures).toEqual([{ names: [ServiceName.make("broken")], error }]);
  });
  test("an empty selection leaves the plan unchanged without building or applying", async () => {
    // Given a plan with no selected services and callbacks that must not run.
    const plan = planWith([service("unselected")]);
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: () => Effect.die(new Error("Unexpected apply")),
    };
    // When no service groups are selected.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(plan, { provider, services: [], options: { reconcile: false } }, () =>
        Effect.die(new Error("Unexpected build")),
      ),
    );
    // Then the original plan is returned with no successes or failures.
    expect(outcome.builtPlan).toBe(plan);
    expect(outcome.services).toEqual([]);
    expect(outcome.failures).toEqual([]);
  });

  test("groups reverse edges and transitive dependencies in plan order", async () => {
    // Given interleaved independent services and a reverse, transitive chain.
    const plan = planWith([service("a"), service("solo"), service("c", ["b"]), service("b", ["a"])]);
    const applied: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan) =>
        Effect.sync(() => {
          applied.push(Object.keys(plan.services));
          return { changed: true };
        }),
    };
    // When the groups are built and applied.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        build,
      ),
    );
    // Then connectivity is undirected and every group preserves plan order.
    expect(applied).toEqual([["a", "c", "b"], ["solo"]]);
    expect(outcome.services.map((service) => String(service.name))).toEqual(["a", "solo", "c", "b"]);
    expect(outcome.failures).toEqual([]);
  });

  test("a build failure does not prevent another group from starting", async () => {
    // Given an independent group whose build fails.
    const plan = planWith([service("broken"), service("working")]);
    const error = failure("broken");
    const applied: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan) =>
        Effect.sync(() => {
          applied.push(Object.keys(plan.services));
          return { changed: true };
        }),
    };
    // When all groups are attempted.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        (plan) =>
          plan.services[ServiceName.make("broken")] === undefined ? build(plan) : Effect.fail(error),
      ),
    );
    // Then the original build error is retained and only the built group is applied.
    expect(outcome.failures).toEqual([{ names: [ServiceName.make("broken")], error }]);
    expect(outcome.failures[0]?.error).toBe(error);
    expect(applied).toEqual([["working"]]);
    expect(outcome.services.map((service) => String(service.name))).toEqual(["working"]);
  });

  test("every group failing returns an outcome with the first original error unchanged", async () => {
    // Given two groups that fail with different original errors.
    const plan = planWith([service("first"), service("second")]);
    const first = failure("first");
    const second = failure("second");
    const attempts: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan) =>
        Effect.sync(() => {
          attempts.push(Object.keys(plan.services));
        }).pipe(
          Effect.andThen(
            Effect.fail(plan.services[ServiceName.make("first")] === undefined ? second : first),
          ),
        ),
    };
    // When both applies fail.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        build,
      ),
    );
    // Then reconciliation receives every failure and no aggregate replaces the first error.
    expect(outcome.services).toEqual([]);
    expect(outcome.failures).toEqual([
      { names: [ServiceName.make("first")], error: first },
      { names: [ServiceName.make("second")], error: second },
    ]);
    expect(globalServiceGroupError("start", outcome)).toBe(first);
    expect(attempts).toEqual([["first"], ["second"]]);
  });

  test.each([
    ["build", "interruption"],
    ["apply", "interruption"],
    ["build", "defect"],
    ["apply", "defect"],
  ] as const)("%s %s propagates without attempting later groups", async (stage, kind) => {
    // Given a first group that interrupts or defects at the selected stage.
    const plan = planWith([service("first"), service("second")]);
    const fatal = kind === "interruption" ? Effect.interrupt : Effect.die(new Error("group defect"));
    const attempts: string[][] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: () => (stage === "apply" ? fatal : Effect.succeed({ changed: true })),
    };
    // When groups execute.
    const exit = await Effect.runPromiseExit(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: false },
        },
        (plan) =>
          Effect.sync(() => {
            attempts.push(Object.keys(plan.services));
          }).pipe(Effect.andThen(stage === "build" ? fatal : build(plan))),
      ),
    );
    // Then the fatal cause retains its class and later groups are not started.
    expect(
      Exit.isFailure(exit) &&
        (kind === "interruption" ? Cause.hasInterruptsOnly(exit.cause) : Cause.hasDies(exit.cause)),
    ).toBe(true);
    expect(attempts).toEqual([["first"]]);
  });

  test("non-reconcile selected start preserves previously built unselected services", async () => {
    // Given a loaded unbuilt plan and an existing built record.
    const selected = service("mailpit");
    const plan = planWith([selected, service("traefik")]);
    let recorded = await Effect.runPromise(build(plan));
    const optionsSeen: ApplyOptions[] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan, options) =>
        Effect.sync(() => {
          optionsSeen.push(options);
          const incoming = options.recordedPlan ?? plan;
          recorded = { ...incoming, services: { ...recorded.services, ...incoming.services } };
          return { changed: true };
        }),
    };
    // When only mailpit starts without reconciliation.
    await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: [selected],
          options: { reconcile: false },
        },
        build,
      ),
    );
    // Then the provider receives no unbuilt full-plan override.
    expect(optionsSeen[0]).not.toHaveProperty("recordedPlan");
    expect(optionsSeen[0]?.completionPlan?.services[ServiceName.make("mailpit")]?.artifact).toEqual({
      kind: "ref",
      ref: "built:mailpit",
    });
    expect(optionsSeen[0]?.completionPlan?.services[ServiceName.make("traefik")]?.artifact).toEqual({
      kind: "ref",
      ref: "unbuilt:traefik",
    });
    expect(refs(recorded)).toEqual([
      { kind: "ref", ref: "built:mailpit" },
      { kind: "ref", ref: "built:traefik" },
    ]);
  });

  test("reconcile applies cumulative built plans when each apply replaces the record", async () => {
    // Given independent services whose recorded plan is replaced on each apply.
    const plan = planWith([service("mailpit"), service("traefik")]);
    const records: AppPlan[] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (plan, options) =>
        Effect.sync(() => {
          records.push(options.recordedPlan ?? plan);
          return { changed: true };
        }),
    };
    // When reconciliation applies both groups.
    await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        {
          provider,
          services: Object.values(plan.services),
          options: { reconcile: true },
        },
        build,
      ),
    );
    // Then the later record retains earlier built entries and the full service set.
    expect(records.map(refs)).toEqual([
      [
        { kind: "ref", ref: "built:mailpit" },
        { kind: "ref", ref: "unbuilt:traefik" },
      ],
      [
        { kind: "ref", ref: "built:mailpit" },
        { kind: "ref", ref: "built:traefik" },
      ],
    ]);
  });

  test("partial error inherits tagged remediation with singular and plural agreement", () => {
    // Given one failed group and several running services.
    const cause = failure("ssh-agent", "Repair the bind source.");
    // When the aggregate is constructed.
    const error = globalServiceGroupError("start", {
      services: [service("mailpit"), service("traefik"), service("traefik-diagnostics")],
      failures: [{ names: ["ssh-agent"], error: cause }],
    });
    // Then the remediation is dedupe-friendly and the cause remains intact.
    expect(error?.message).toBe(
      "Global service ssh-agent failed to start; mailpit, traefik, traefik-diagnostics are running.",
    );
    expect(error?.remediation).toBe("Repair the bind source.");
    expect(error?.cause).toBe(cause);
  });

  test("applies the resolved debugger address while building and recording neutral plans", async () => {
    // Given a service that requests the debugger alias and a configured debugger host.
    const plan = planWith([
      { ...service("debuggable"), hostAliases: [{ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET }] },
    ]);
    const built: AppPlan[] = [];
    const applied: AppPlan[] = [];
    const recorded: AppPlan[] = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      apply: (group, options) =>
        Effect.sync(() => {
          applied.push(group);
          if (options?.recordedPlan !== undefined) recorded.push(options.recordedPlan);
          return { changed: true };
        }),
    };
    const config = Schema.decodeUnknownSync(GlobalConfig)({ debugger: { host: "192.0.2.40" } });
    // When the groups are built and applied.
    const outcome = await Effect.runPromise(
      applyGlobalServiceGroups(
        plan,
        { provider, services: Object.values(plan.services), options: { reconcile: true } },
        (value) => {
          built.push(value);
          return build(value);
        },
      ).pipe(
        Effect.provideService(
          ConfigService,
          ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
        ),
      ),
    );
    // Then only the provider receives the resolved address.
    const alias = (value: AppPlan) => value.services[ServiceName.make("debuggable")]?.hostAliases[0]?.ip;
    expect(outcome.failures).toEqual([]);
    expect(applied.map(alias)).toEqual(["192.0.2.40"]);
    expect(built.map(alias)).toEqual([HOST_GATEWAY_TARGET]);
    expect(recorded.map(alias)).toEqual([HOST_GATEWAY_TARGET]);
    expect(alias(outcome.builtPlan)).toBe(HOST_GATEWAY_TARGET);
  });

  test("no failures produce no aggregate error", () => {
    // Given a successful service outcome.
    const outcome = { services: [service("working")], failures: [] };
    // When an aggregate error is requested.
    const error = globalServiceGroupError("start", outcome);
    // Then success is not reported as a partial failure.
    expect(error).toBeUndefined();
  });

  test.each([
    [
      "start",
      "Fix the error above, then run `lando global:start` to retry the global services. Run `lando doctor` if the failure persists.",
    ],
    [
      "rebuild",
      "Fix the error above, then run `lando global:rebuild`. Run `lando doctor` if the failure persists.",
    ],
  ] as const)("partial %s errors use operation-specific fallback remediation", (operation, remediation) => {
    // Given multiple failed services whose cause has no tagged remediation, and one running service.
    const cause = new Error("broken without tagged remediation");
    // When the aggregate is constructed for the selected operation.
    const error = globalServiceGroupError(operation, {
      services: [service("working")],
      failures: [{ names: ["broken", "dependent"], error: cause }],
    });
    // Then fallback instructions match the operation and grammar matches the service counts.
    if (error === undefined || !(error instanceof GlobalAppError)) throw new Error("expected GlobalAppError");
    expect(error.remediation).toBe(remediation);
    expect(error.message).toBe(
      `Global services broken, dependent failed to ${operation}; working is running.`,
    );
    expect(error.cause).toBe(cause);
  });
});

test("post-build admission failure preserves an earlier applied group and skips the stale group", async () => {
  const first = service("first");
  const second = service("second");
  const plan = planWith([first, second]);
  const applied: string[] = [];
  const timeline: string[] = [];
  let admitted = true;
  const changed = new GlobalAppError({
    operation: "startup-admission",
    message: "Saved policy changed during the second build.",
    remediation: "Retry with the current policy.",
  });
  const outcome = await Effect.runPromise(
    applyGlobalServiceGroups(
      plan,
      {
        provider: {
          ...TestRuntimeProvider,
          apply: (group) =>
            Effect.sync(() => {
              const name = Object.keys(group.services)[0];
              if (name === undefined) throw new Error("expected selected group");
              applied.push(name);
              timeline.push(`apply:${name}`);
              return { changed: true };
            }),
        },
        services: [first, second],
        options: { reconcile: false },
        beforeApply: Effect.suspend(() => {
          timeline.push("admission");
          return admitted ? Effect.void : Effect.fail(changed);
        }),
      },
      (group) =>
        Effect.sync(() => {
          const name = Object.keys(group.services)[0];
          timeline.push(`build:${name}`);
          if (name === "second") admitted = false;
          return group;
        }),
    ),
  );
  expect(timeline).toEqual([
    "build:first",
    "admission",
    "admission",
    "apply:first",
    "build:second",
    "admission",
  ]);
  expect(applied).toEqual(["first"]);
  expect(outcome.services.map((service) => service.name)).toEqual([first.name]);
  expect(outcome.failures).toEqual([{ names: [second.name], error: changed }]);
  const error = globalServiceGroupError("start", outcome);
  expect(error).toMatchObject({ _tag: "GlobalAppError", operation: "start", cause: changed });
  expect(error?.message).toContain("first is running");
});

test("each global group reserves its selected IDs inside provider apply while sharing one environment session", async () => {
  const first = service("first");
  const second = service("second");
  const plan = planWith([first, second]);
  const observed: string[][] = [];
  let sessions = 0;
  const resolver = EnvironmentValueResolver.of({
    openSession: () =>
      Effect.sync(() => {
        sessions++;
        return { resolveEnvironment: () => Effect.succeed({}) };
      }),
  });
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    apply: (group) =>
      Effect.gen(function* () {
        const records = yield* readGlobalConsumerReservations(["first", "second"]);
        expect(records).toHaveLength(1);
        expect(records[0]?.app.kind).toBe("global");
        expect(records[0]?.app.root).toBe(root);
        expect(records[0]?.services).toEqual(Object.keys(group.services));
        observed.push([...(records[0]?.services ?? [])]);
        return { changed: true };
      }).pipe(Effect.provide(leaseLayer), Effect.orDie),
  };
  await Effect.runPromise(
    withGlobalMutation(
      applyGlobalServiceGroupsEffect(
        plan,
        {
          provider,
          services: [first, second],
          options: { reconcile: false },
        },
        build,
      ).pipe(Effect.provideService(EnvironmentValueResolver, resolver)),
    ).pipe(Effect.provide(leaseLayer)),
  );
  expect(sessions).toBe(1);
  expect(observed).toEqual([["first"], ["second"]]);
});
