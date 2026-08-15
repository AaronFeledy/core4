import { describe, expect, test } from "bun:test";

import {
  Cause,
  type Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  TestClock,
  TestContext,
} from "effect";

import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider, makeTestSecretStore } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
import { RedactionServiceLive } from "@lando/redaction/service";
import { ConfigError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule, PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { type GlobalConfig, PluginManifest, ProviderId } from "@lando/sdk/schema";
import { probeBudgetMs } from "../../src/cli/commands/doctor-plugin-checks.ts";
import {
  DoctorReportSchema,
  collectDoctorReport,
  doctorReport,
} from "../../src/cli/commands/doctor-report.ts";
import { doctor } from "../../src/cli/commands/doctor.ts";

/**
 * Chaos coverage for the doctor self-resilience contract: every service doctor
 * depends on is made to fail, die, or hang, and doctor must still answer with a
 * structured report instead of propagating the breakage it exists to report.
 */

const SHORT_BUDGET_ENV = { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } as const;

const buildConfigService = (
  options: { readonly failGet?: boolean } = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) =>
      options.failGet === true
        ? Effect.fail(new ConfigError({ message: `config file is corrupt: ${String(key)}` }))
        : Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const failingSelectRegistry = () => ({
  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () =>
    Effect.fail(
      new ProviderUnavailableError({
        providerId: TestRuntimeProvider.id,
        operation: "select",
        message: "runtime socket is unreachable",
      }),
    ),
});

const statusRegistry = (getStatus: typeof TestRuntimeProvider.getStatus) => ({
  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.succeed({ ...TestRuntimeProvider, getStatus }),
});

const doctorModule = (check: PluginDoctorCheckContribution): LandoPluginModule => ({
  name: "@lando/doctor-chaos",
  manifest: Schema.decodeSync(PluginManifest)({
    name: "@lando/doctor-chaos",
    version: "1.0.0",
    api: 4,
  }),
  doctorChecks: [check],
});

const layersFor = (
  registry: ReturnType<typeof statusRegistry> | ReturnType<typeof failingSelectRegistry>,
  configOptions: { readonly failGet?: boolean } = {},
) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeProviderRegistry, registry as never),
    Layer.succeed(ConfigService, buildConfigService(configOptions)),
    Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} })),
  );

const selfSections = (report: { readonly self?: { readonly checks: ReadonlyArray<{ section: string }> } }) =>
  (report.self?.checks ?? []).map((check) => check.section);

describe("doctor chaos: provider path", () => {
  test("interrupts doctor when its AbortSignal aborts mid-flight", async () => {
    // Given a provider status probe that has started and will never settle
    const started = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const layers = layersFor(
      statusRegistry(
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When the caller aborts the run
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(doctor({ signal: controller.signal }).pipe(Effect.provide(layers)));
        yield* Deferred.await(started);
        yield* Effect.sync(() => controller.abort());
        return yield* Fiber.await(fiber);
      }),
    );

    // Then cancellation interrupts the run instead of becoming a self check
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isInterrupted(exit.cause)).toBe(true);
  });

  test("reports a failed selected-provider check when provider selection fails", async () => {
    // Given a registry whose select always fails
    const layers = layersFor(failingSelectRegistry());

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then doctor answers instead of failing, and names the remediation
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check).toMatchObject({
      name: "selected-provider",
      status: "fail",
      severity: "error",
      runtimeStatus: "unavailable",
    });
    expect(check?.context.failure).toBe("ProviderUnavailableError");
    expect(check?.solutions.map((solution) => solution.command)).toContain("lando setup");
    expect(check?.selection?.providerId).toBe("lando");
  });

  test("degrades to a failed check when the provider status probe fails", async () => {
    // Given
    const layers = layersFor(
      statusRegistry(
        Effect.fail(
          new ProviderUnavailableError({
            providerId: TestRuntimeProvider.id,
            operation: "getStatus",
            message: "status probe exploded",
          }),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check?.status).toBe("fail");
    expect(check?.context.statusProbe).toBe("failure");
    expect(result.selfChecks?.map((entry) => entry.section)).toContain("provider-status");
  });

  test("bounds a hanging provider status probe and keeps answering", async () => {
    // Given a status probe that never settles
    const layers = layersFor(statusRegistry(Effect.never as typeof TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(doctor({ env: SHORT_BUDGET_ENV }).pipe(Effect.provide(layers)));

    // Then
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check?.status).toBe("fail");
    expect(check?.context.statusProbe).toBe("timeout");
    expect(check?.runtimeStatus).toContain("timed out");
  });

  test("records a self check when configuration cannot be read", async () => {
    // Given a ConfigService whose reads always fail
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus), { failGet: true });

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then selection still resolves from the capability default
    expect(result.selfChecks?.map((entry) => entry.section)).toContain("provider-selection-config");
    expect(result.checks.find((entry) => entry.name === "selected-provider")).toBeDefined();
  });
});

describe("doctor chaos: plugin-contributed checks", () => {
  test("keeps the plugin probe budget strictly below the report section budget", () => {
    // Given
    const reportBudgetMs = 1_000;

    // When
    const pluginBudgetMs = probeBudgetMs(reportBudgetMs);

    // Then
    expect(pluginBudgetMs * 2).toBeLessThan(reportBudgetMs);
  });

  test("attributes a dying plugin check instead of failing the run", async () => {
    // Given
    const module = doctorModule({ id: "chaos-die", run: () => Effect.die(new Error("plugin exploded")) });
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(doctor({}, [module]).pipe(Effect.provide(layers)));

    // Then the built-in checks survive and the failure is attributed
    expect(result.checks.find((entry) => entry.name === "selected-provider")).toBeDefined();
    const self = result.selfChecks?.find((entry) => entry.section === "plugin-check:chaos-die");
    expect(self).toMatchObject({ status: "fail", severity: "error", reason: "defect" });
    expect(self?.context.checkId).toBe("chaos-die");
  });

  test("isolates duplicate doctor-check descriptors without leaking registered secrets", async () => {
    // Given two plugins with the same secret-bearing doctor-check id
    const secret = "duplicate-doctor-secret-9f3a";
    const duplicateId = `duplicate-${secret}`;
    const first = doctorModule({
      id: duplicateId,
      run: () =>
        Effect.succeed([
          {
            name: "duplicate-report-first",
            status: "pass" as const,
            severity: "info" as const,
            context: {},
            solutions: [],
          },
        ]),
    });
    const second: LandoPluginModule = {
      ...doctorModule({
        id: duplicateId,
        run: () =>
          Effect.succeed([
            {
              name: "duplicate-report-second",
              status: "pass" as const,
              severity: "info" as const,
              context: {},
              solutions: [],
            },
          ]),
      }),
      name: "@lando/doctor-chaos-duplicate",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/doctor-chaos-duplicate",
        version: "1.0.0",
        api: 4,
      }),
    };
    const secretStore = makeTestSecretStore({ secrets: { DUPLICATE_DOCTOR_TOKEN: secret } });
    const redactionLayer = RedactionServiceLive.pipe(Layer.provide(secretStore.layer));
    const layers = Layer.merge(layersFor(statusRegistry(TestRuntimeProvider.getStatus)), redactionLayer);

    // When
    const result = await Effect.runPromise(doctor({}, [first, second]).pipe(Effect.provide(layers)));

    // Then index failure is isolated while built-in provider diagnostics survive
    const selfChecks = (result.selfChecks ?? []).filter((check) => check.section === "plugin-doctor-checks");
    expect(selfChecks).toHaveLength(1);
    expect(selfChecks[0]).toMatchObject({
      reason: "failure",
      context: { failure: "PluginDescriptorMismatchError" },
    });
    expect(selfChecks[0]?.solutions.some((solution) => solution.description.includes("plugin list"))).toBe(
      true,
    );
    expect(result.checks.some((check) => check.name.startsWith("duplicate-report-"))).toBe(false);
    expect(result.checks.some((check) => check.name === "selected-provider")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("bounds a hanging plugin check", async () => {
    // Given
    const module = doctorModule({ id: "chaos-hang", run: () => Effect.never });
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(
      doctor({ env: SHORT_BUDGET_ENV }, [module]).pipe(Effect.provide(layers)),
    );

    // Then
    const self = result.selfChecks?.find((entry) => entry.section === "plugin-check:chaos-hang");
    expect(self?.reason).toBe("timeout");
    expect(result.checks.find((entry) => entry.name === "selected-provider")).toBeDefined();
  });

  test("keeps healthy plugin checks when a sibling check dies", async () => {
    // Given one healthy and one dying contribution
    const healthy = doctorModule({
      id: "chaos-healthy",
      run: () =>
        Effect.succeed([
          {
            name: "chaos-healthy",
            status: "pass" as const,
            severity: "info" as const,
            context: {},
            solutions: [],
          },
        ]),
    });
    const dying: LandoPluginModule = {
      ...doctorModule({ id: "chaos-sibling-die", run: () => Effect.die(new Error("nope")) }),
      name: "@lando/doctor-chaos-2",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/doctor-chaos-2",
        version: "1.0.0",
        api: 4,
      }),
    };
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const result = await Effect.runPromise(doctor({}, [healthy, dying]).pipe(Effect.provide(layers)));

    // Then
    expect(result.checks.find((entry) => entry.name === "chaos-healthy")?.status).toBe("pass");
    expect(result.selfChecks?.map((entry) => entry.section)).toContain("plugin-check:chaos-sibling-die");
  });

  test("isolates a hanging contribution inside the report while retaining its healthy sibling", async () => {
    // Given a hanging contribution before a healthy sibling
    const hangStarted = Effect.runSync(Deferred.make<void>());
    const healthyStarted = Effect.runSync(Deferred.make<void>());
    const hanging = doctorModule({
      id: "chaos-report-hang",
      run: () => Deferred.succeed(hangStarted, undefined).pipe(Effect.zipRight(Effect.never)),
    });
    const healthy: LandoPluginModule = {
      ...doctorModule({
        id: "chaos-report-healthy",
        run: () =>
          Deferred.succeed(healthyStarted, undefined).pipe(
            Effect.as([
              {
                name: "chaos-report-healthy",
                status: "pass" as const,
                severity: "info" as const,
                context: {},
                solutions: [],
              },
            ]),
          ),
      }),
      name: "@lando/doctor-chaos-healthy",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/doctor-chaos-healthy",
        version: "1.0.0",
        api: 4,
      }),
    };
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const options = { env: SHORT_BUDGET_ENV };
        const fiber = yield* Effect.fork(
          collectDoctorReport({
            options,
            provider: doctor(options, [hanging, healthy]),
            deprecations: Effect.succeed({ entries: [] }),
          }),
        );
        yield* Deferred.await(hangStarted);
        yield* Effect.yieldNow();
        expect(Option.isSome(yield* Deferred.poll(healthyStarted))).toBe(true);
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers), Effect.provide(TestContext.TestContext)),
    );

    // Then
    const sections = selfSections(report);
    expect(sections.filter((section) => section.startsWith("plugin-check:"))).toEqual([
      "plugin-check:chaos-report-hang",
    ]);
    expect(sections).not.toContain("provider");
    expect(
      report.provider.checks.find((entry) => entry.name === "selected-provider")?.selection?.providerId,
    ).toBe("lando");
    expect(report.provider.checks.find((entry) => entry.name === "chaos-report-healthy")?.status).toBe(
      "pass",
    );
  });

  test("preserves contribution input order when checks complete in reverse", async () => {
    // Given two checks whose second completion releases the first
    const firstStarted = Effect.runSync(Deferred.make<void>());
    const secondFinished = Effect.runSync(Deferred.make<void>());
    const first = doctorModule({
      id: "chaos-order-first",
      run: () =>
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(secondFinished)),
          Effect.as([
            {
              name: "chaos-order-first",
              status: "pass" as const,
              severity: "info" as const,
              context: {},
              solutions: [],
            },
          ]),
        ),
    });
    const second: LandoPluginModule = {
      ...doctorModule({
        id: "chaos-order-second",
        run: () =>
          Effect.succeed([
            {
              name: "chaos-order-second",
              status: "pass" as const,
              severity: "info" as const,
              context: {},
              solutions: [],
            },
          ]).pipe(Effect.ensuring(Deferred.succeed(secondFinished, undefined))),
      }),
      name: "@lando/doctor-chaos-order-second",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/doctor-chaos-order-second",
        version: "1.0.0",
        api: 4,
      }),
    };
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const options = { env: SHORT_BUDGET_ENV };
        const fiber = yield* Effect.fork(
          collectDoctorReport({
            options,
            provider: doctor(options, [first, second]),
            deprecations: Effect.succeed({ entries: [] }),
          }),
        );
        yield* Deferred.await(firstStarted);
        yield* Effect.yieldNow();
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers), Effect.provide(TestContext.TestContext)),
    );

    // Then
    expect(
      report.provider.checks
        .filter((entry) => entry.name.startsWith("chaos-order-"))
        .map((entry) => entry.name),
    ).toEqual(["chaos-order-first", "chaos-order-second"]);
  });

  test("keeps inner attribution when sequential plugin and provider probes exhaust the report budget", async () => {
    // Given a hanging plugin followed by a hanging primary provider status probe
    const pluginStarted = Effect.runSync(Deferred.make<void>());
    const providerStarted = Effect.runSync(Deferred.make<void>());
    const hanging = doctorModule({
      id: "chaos-aggregate-hang",
      run: () => Deferred.succeed(pluginStarted, undefined).pipe(Effect.zipRight(Effect.never)),
    });
    const layers = layersFor(
      statusRegistry(
        Deferred.succeed(providerStarted, undefined).pipe(
          Effect.zipRight(Effect.never),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const reportOptions = { env: SHORT_BUDGET_ENV };
        const doctorOptions = { env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "800" } };
        const fiber = yield* Effect.fork(
          collectDoctorReport({
            options: reportOptions,
            provider: doctor(doctorOptions, [hanging]),
            deprecations: Effect.succeed({ entries: [] }),
          }),
        );
        yield* Deferred.await(pluginStarted);
        yield* TestClock.adjust("800 millis");
        yield* Deferred.await(providerStarted);
        yield* TestClock.adjust("200 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers), Effect.provide(TestContext.TestContext)),
    );

    // Then both inner timeouts remain attributed and the selected provider survives
    const sections = selfSections(report);
    expect(sections).toContain("plugin-check:chaos-aggregate-hang");
    expect(sections).toContain("provider-status");
    expect(report.provider.checks.map((check) => check.name)).toContain("selected-provider");
    expect(sections).not.toContain("provider");
  });
});

describe("doctor chaos: whole report", () => {
  test("interrupts collectDoctorReport when its AbortSignal aborts mid-flight", async () => {
    // Given a provider section that has started and will never settle
    const started = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const layers = layersFor(statusRegistry(TestRuntimeProvider.getStatus));

    // When the caller aborts the report collector
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          collectDoctorReport({
            options: { signal: controller.signal },
            provider: Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
            deprecations: Effect.succeed({ entries: [] }),
          }).pipe(Effect.provide(layers)),
        );
        yield* Deferred.await(started);
        yield* Effect.sync(() => controller.abort());
        return yield* Fiber.await(fiber);
      }),
    );

    // Then cancellation interrupts collection instead of becoming a provider self check
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isInterrupted(exit.cause)).toBe(true);
  });

  test("interrupts doctorReport when its AbortSignal aborts mid-flight", async () => {
    // Given a provider section that has started and will never settle
    const started = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const layers = layersFor(
      statusRegistry(
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.never),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When the caller aborts the report
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          doctorReport({ signal: controller.signal }).pipe(Effect.provide(layers)),
        );
        yield* Deferred.await(started);
        yield* Effect.sync(() => controller.abort());
        return yield* Fiber.await(fiber);
      }),
    );

    // Then cancellation interrupts the report instead of becoming a provider self check
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.isInterrupted(exit.cause)).toBe(true);
  });

  test("emits a schema-valid report when the provider section is fully broken", async () => {
    // Given provider selection failure and a corrupt config at the same time
    const layers = layersFor(failingSelectRegistry(), { failGet: true });

    // When
    const report = await Effect.runPromise(
      doctorReport({ env: SHORT_BUDGET_ENV }).pipe(Effect.provide(layers)),
    );

    // Then the report is still structured, schema-valid, and carries self checks
    expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    expect(report.provider.checks.length).toBeGreaterThan(0);
    expect(selfSections(report)).toContain("provider-selection-config");
    // Provider-section self checks are lifted to the report level, never duplicated.
    expect(report.provider).not.toHaveProperty("selfChecks");
  });

  test("redacts secrets out of a failure message before it reaches the report", async () => {
    // Given a failure message containing a value the env marks as a secret
    const secret = "super-secret-token-value";
    const registry = {
      list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: TestRuntimeProvider.id,
            operation: "select",
            message: `socket auth failed using ${secret}`,
          }),
        ),
    };
    const layers = layersFor(registry);

    // When
    const result = await Effect.runPromise(
      doctor({ env: { ...SHORT_BUDGET_ENV, LANDO_TEST_TOKEN: secret } }).pipe(Effect.provide(layers)),
    );

    // Then
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(JSON.stringify(check)).not.toContain(secret);
  });
});
