import { describe, expect, test } from "bun:test";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule, PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { type GlobalConfig, PluginManifest, ProviderId } from "@lando/sdk/schema";
import { Cause, type Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { DoctorSectionResult } from "../../src/cli/commands/doctor.ts";
import { doctor } from "../../src/cli/commands/doctor.ts";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";
import { probeBudgetMs } from "../../src/cli/commands/doctor-plugin-checks.ts";
import {
  DoctorReportSchema,
  collectDoctorReport,
  doctorReport,
} from "../../src/cli/commands/doctor-report.ts";
import { isolateDoctorSection } from "../../src/cli/commands/doctor-self.ts";
import { makeLandoRuntime } from "../../src/runtime/layer";

/**
 * Chaos coverage for the doctor self-resilience contract: every service doctor
 * depends on is made to fail, die, or hang, and doctor must still answer with a
 * structured report instead of propagating the breakage it exists to report.
 */

const SHORT_BUDGET_ENV = { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } as const;

const buildConfigService = (): Context.Service.Shape<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return ConfigService.of({
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  });
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
        remediation: "Install or start the selected runtime provider and confirm it can perform `select`.",
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

const layersFor = (registry: ReturnType<typeof statusRegistry> | ReturnType<typeof failingSelectRegistry>) =>
  Layer.mergeAll(
    Layer.succeed(RuntimeProviderRegistry, RuntimeProviderRegistry.of(registry as never)),
    Layer.succeed(ConfigService, ConfigService.of(buildConfigService())),
    Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} })),
  );

/**
 * Effect 4's TestClock fires every due sleep in one `adjust`, yielding only once
 * between them, so work woken by an earlier deadline cannot settle before a later
 * deadline fires. Advance a millisecond at a time and drain the scheduler between
 * steps, as a real clock would.
 */
const advanceSettled = Effect.fnUntraced(function* (millis: number) {
  for (let elapsed = 0; elapsed < millis; elapsed += 1) {
    yield* TestClock.adjust("1 millis");
    yield* Effect.promise(() => new Promise<void>((resume) => setImmediate(resume)));
  }
});

const selfSections = (report: DoctorSectionResult) =>
  report.checks
    .filter((check) => check.name === "doctor-self")
    .map((check) => check.context.probe ?? "provider");

describe("doctor chaos: provider path", () => {
  test("interrupts doctor when its AbortSignal aborts mid-flight", async () => {
    // Given a provider status probe that has started and will never settle
    const started = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const layers = layersFor(
      statusRegistry(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When the caller aborts the run
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          doctor({ signal: controller.signal }).pipe(Effect.provide(layers)),
        );
        yield* Deferred.await(started);
        yield* Effect.sync(() => controller.abort());
        return yield* Fiber.await(fiber);
      }),
    );

    // Then cancellation interrupts the run instead of becoming a self check
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
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
    });
    expect(result.provider?.runtimeStatus).toBe("unavailable");
    expect(check?.context.failure).toBe("ProviderUnavailableError");
    expect(check?.solutions.map((solution) => solution.command)).toContain("lando setup");
    expect(result.provider?.selection.providerId).toBe("lando");
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
            remediation:
              "Install or start the selected runtime provider and confirm it can perform `getStatus`.",
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
    expect(selfSections(result)).not.toContain("provider-status");
  });

  test("classifies a failing status read by its cause instead of assuming a timeout", async () => {
    // Given a status probe that dies with a defect
    const layers = layersFor(statusRegistry(Effect.die(new Error("status probe exploded"))));

    // When
    const result = await Effect.runPromise(doctor({}).pipe(Effect.provide(layers)));

    // Then the defect is reported as a defect, not as an unreachable timeout
    const check = result.checks.find((entry) => entry.name === "selected-provider");
    expect(check?.status).toBe("fail");
    expect(check?.context.statusProbe).toBe("defect");
    expect(result.provider?.runtimeStatus).toBe("unknown (status probe failed)");
    expect(
      result.checks.find((entry) => entry.name === "doctor-self" && entry.context.probe === "provider-status")
        ?.context.reason,
    ).toBe("defect");
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
    expect(result.provider?.runtimeStatus).toContain("timed out");
  });

  test("reports invalid configuration as a global-config finding without a self check", async () => {
    // Given a ConfigService whose reads always fail
    const layers = makeLandoRuntime({
      bootstrap: "none",
      configSources: { user: false, env: false },
      config: { router: { httpPort: 99999 } },
    });

    // When
    const result = await Effect.runPromise(resilientDoctorReport({}).pipe(Effect.provide(layers)));

    // Then the expected configuration failure is a global-config finding, not a self failure
    const globalConfig = result.checks.find((entry) => entry.section === "global-config");
    expect(globalConfig).toMatchObject({ status: "fail", details: { _tag: "ConfigError" } });
    expect(result.checks.filter((entry) => entry.name === "doctor-self")).toEqual([]);
    expect(result.checks.filter((entry) => entry.section === "provider")).toEqual([]);
    expect(
      globalConfig?.details !== undefined && "issues" in globalConfig.details
        ? globalConfig.details.issues?.[0]?.source?.layer
        : undefined,
    ).toBe("host");
  });

  test("classifies a config validation defect as a global-config self check", async () => {
    // Given a configuration source whose snapshot read throws instead of returning a ConfigError
    const sources = GlobalConfigSources.of(
      Object.defineProperty(
        { env: {}, sources: { user: false, env: false }, rootOverrides: {} },
        "snapshot",
        {
          get() {
            throw new Error("config snapshot exploded");
          },
        },
      ),
    );
    const runtimeLayer = Layer.mergeAll(
      layersFor(statusRegistry(TestRuntimeProvider.getStatus)),
      Layer.succeed(
        PluginRegistryLayer.PluginRegistry,
        PluginRegistryLayer.PluginRegistry.of({
          list: Effect.succeed([]),
          load: () => Effect.die("unused"),
          loadServiceType: () => Effect.die("unused"),
          loadServiceFeature: () => Effect.die("unused"),
          loadAppFeature: () => Effect.die("unused"),
        }),
      ),
    );
    const factory = Layer.succeed(RuntimeLayerFactory, RuntimeLayerFactory.of({ make: () => runtimeLayer }));

    // When
    const result = await Effect.runPromise(
      resilientDoctorReport({ env: SHORT_BUDGET_ENV }).pipe(
        Effect.provide(Layer.merge(factory, Layer.succeed(GlobalConfigSources, sources))),
      ),
    );

    // Then the defect is a self failure attributed to global-config, not a doctor finding
    const self = result.checks.find((entry) => entry.name === "doctor-self");
    expect(self).toMatchObject({
      section: "global-config",
      status: "fail",
      severity: "error",
      context: { reason: "defect", message: "config snapshot exploded" },
    });
    expect(
      result.checks.filter((entry) => entry.section === "global-config" && entry.name !== "doctor-self"),
    ).toEqual([]);
  });

  test("attributes a config validation timeout to a global-config self check", async () => {
    // Given a config layer that never finishes building
    // When the isolated config operation exceeds its budget
    const outcome = await Effect.runPromise(
      isolateDoctorSection({
        section: "global-config",
        effect: Effect.never,
        fallback: undefined,
        budgetMs: 1_000,
      }),
    );

    // Then the timeout is a self failure attributed to global-config
    expect(outcome.self).toMatchObject({
      section: "global-config",
      status: "fail",
      severity: "error",
      context: { reason: "timeout" },
    });
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
    const self = result.checks.find(
      (check) => check.name === "doctor-self" && check.context.probe === "plugin-check:chaos-die",
    );
    expect(self).toMatchObject({
      status: "fail",
      severity: "error",
      context: { reason: "defect", checkId: "chaos-die" },
    });
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
    const redactionLayer = Layer.effect(
      RedactionService,
      Effect.gen(function* () {
        const service = yield* RedactionService;
        yield* service.registerValues([secret]);
        return service;
      }),
    ).pipe(Layer.provide(RedactionService.layer));
    const layers = Layer.merge(layersFor(statusRegistry(TestRuntimeProvider.getStatus)), redactionLayer);

    // When
    const result = await Effect.runPromise(doctor({}, [first, second]).pipe(Effect.provide(layers)));

    // Then index failure is isolated while built-in provider diagnostics survive
    const selfChecks = result.checks.filter(
      (check) => check.name === "doctor-self" && check.context.probe === "plugin-doctor-checks",
    );
    expect(selfChecks).toHaveLength(1);
    expect(selfChecks[0]).toMatchObject({
      context: { probe: "plugin-doctor-checks", reason: "failure", failure: "PluginDescriptorMismatchError" },
    });
    expect(
      selfChecks[0]?.solutions.some((solution) =>
        solution.description.includes("lando plugin:remove <name>"),
      ),
    ).toBe(true);
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
    const self = result.checks.find(
      (check) => check.name === "doctor-self" && check.context.probe === "plugin-check:chaos-hang",
    );
    expect(self?.context.reason).toBe("timeout");
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
    expect(selfSections(result)).toContain("plugin-check:chaos-sibling-die");
  });

  test("isolates a hanging contribution inside the report while retaining its healthy sibling", async () => {
    // Given a hanging contribution before a healthy sibling
    const hangStarted = Effect.runSync(Deferred.make<void>());
    const healthyStarted = Effect.runSync(Deferred.make<void>());
    const hanging = doctorModule({
      id: "chaos-report-hang",
      run: () => Deferred.succeed(hangStarted, undefined).pipe(Effect.andThen(Effect.never)),
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
        const fiber = yield* Effect.forkChild(
          collectDoctorReport({
            options,
            provider: doctor(options, [hanging, healthy]),
            deprecations: Effect.succeed({ entries: [] }),
          }),
        );
        yield* Deferred.await(hangStarted);
        yield* Effect.yieldNow;
        expect(Option.isSome(yield* Deferred.poll(healthyStarted))).toBe(true);
        yield* advanceSettled(1_000);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer())),
    );

    // Then
    const sections = selfSections(report);
    expect(sections.filter((section) => section.startsWith("plugin-check:"))).toEqual([
      "plugin-check:chaos-report-hang",
    ]);
    expect(sections).not.toContain("provider");
    expect(report.provider?.selection.providerId).toBe("lando");
    expect(
      report.checks.find((check) => check.section === "provider" && check.name === "chaos-report-healthy")
        ?.status,
    ).toBe("pass");
  });

  test("preserves contribution input order when checks complete in reverse", async () => {
    // Given two checks whose second completion releases the first
    const firstStarted = Effect.runSync(Deferred.make<void>());
    const secondFinished = Effect.runSync(Deferred.make<void>());
    const first = doctorModule({
      id: "chaos-order-first",
      run: () =>
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(secondFinished)),
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
        const fiber = yield* Effect.forkChild(
          collectDoctorReport({
            options,
            provider: doctor(options, [first, second]),
            deprecations: Effect.succeed({ entries: [] }),
          }),
        );
        yield* Deferred.await(firstStarted);
        yield* Effect.yieldNow;
        yield* advanceSettled(1_000);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer())),
    );

    // Then
    expect(
      report.checks
        .filter((check) => check.section === "provider" && check.name.startsWith("chaos-order-"))
        .map((entry) => entry.name),
    ).toEqual(["chaos-order-first", "chaos-order-second"]);
  });

  test("keeps inner attribution when sequential plugin and provider probes exhaust the report budget", async () => {
    // Given a hanging plugin followed by a hanging primary provider status probe
    const pluginStarted = Effect.runSync(Deferred.make<void>());
    const providerStarted = Effect.runSync(Deferred.make<void>());
    const hanging = doctorModule({
      id: "chaos-aggregate-hang",
      run: () => Deferred.succeed(pluginStarted, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const layers = layersFor(
      statusRegistry(
        Deferred.succeed(providerStarted, undefined).pipe(
          Effect.andThen(Effect.never),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const reportOptions = { env: SHORT_BUDGET_ENV };
        const doctorOptions = { env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "800" } };
        const fiber = yield* Effect.forkChild(
          collectDoctorReport({
            options: reportOptions,
            provider: doctor(doctorOptions, [hanging]),
            deprecations: Effect.succeed({ entries: [] }),
          }),
        );
        yield* Deferred.await(pluginStarted);
        yield* advanceSettled(800);
        yield* Deferred.await(providerStarted);
        yield* advanceSettled(200);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer())),
    );

    // Then both inner timeouts remain attributed and the selected provider survives
    const sections = selfSections(report);
    expect(sections).toContain("plugin-check:chaos-aggregate-hang");
    expect(sections).toContain("provider-status");
    expect(
      report.checks.filter((check) => check.section === "provider").map((check) => check.name),
    ).toContain("selected-provider");
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
        const fiber = yield* Effect.forkChild(
          collectDoctorReport({
            options: { signal: controller.signal },
            provider: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
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
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  test("interrupts doctorReport when its AbortSignal aborts mid-flight", async () => {
    // Given a provider section that has started and will never settle
    const started = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const layers = layersFor(
      statusRegistry(
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
        ) as typeof TestRuntimeProvider.getStatus,
      ),
    );

    // When the caller aborts the report
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          doctorReport({ signal: controller.signal }).pipe(
            Effect.provide(layers),
            Effect.provide(PluginRegistryLayer.layer),
          ),
        );
        yield* Deferred.await(started);
        yield* Effect.sync(() => controller.abort());
        return yield* Fiber.await(fiber);
      }),
    );

    // Then cancellation interrupts the report instead of becoming a provider self check
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  test("emits a schema-valid report when the provider section is fully broken", async () => {
    // Given provider selection failure and a corrupt config at the same time
    const layers = layersFor(failingSelectRegistry());

    // When
    const report = await Effect.runPromise(
      doctorReport({ env: SHORT_BUDGET_ENV }).pipe(
        Effect.provide(layers),
        Effect.provide(PluginRegistryLayer.layer),
      ),
    );

    // Then the report is still structured, schema-valid, and carries self checks
    expect(() => Schema.encodeSync(DoctorReportSchema)(report)).not.toThrow();
    expect(
      report.checks.find((check) => check.section === "provider" && check.name === "selected-provider")
        ?.status,
    ).toBe("fail");
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
            remediation:
              "Install or start the selected runtime provider and confirm it can perform `select`.",
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
