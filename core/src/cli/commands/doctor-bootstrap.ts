import { CORE_VERSION } from "@lando/engine/version";
import type { ConfigError } from "@lando/sdk/errors";
/**
 * Safe-mode `lando doctor` entry point.
 *
 * `meta:doctor` validates global config before building the provider runtime.
 * Invalid config skips dependent sections; provider bootstrap failures become
 * self checks while independent diagnostics continue.
 *
 * The runtime is built exactly once, inside a `Scope` that stays open for the
 * runtime-dependent sections and closes with the report.
 */
import { Context, Effect, Layer, Option, type Scope } from "effect";

import { recordConfigWarning } from "@lando/engine/config/config-warnings";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import * as LandoConfigService from "@lando/engine/services/config";
import { type DoctorOptions, doctor } from "./doctor";
import { interruptOnAbort } from "./doctor-abort";
import { UNRESOLVED_CERTS_STATUS, certsDoctorStatus } from "./doctor-certs-status";
import { filesystemWatchDoctor } from "./doctor-filesystem-watch";
import { appConfigForReport, collectDoctorReport, doctorDeprecations } from "./doctor-report";
import type { DoctorReport } from "./doctor-report-contract";
import { type DoctorSelfSolution, doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "./doctor-subsystems";
import { resolveSecretsRedactor } from "./secrets-redactor";

const BOOTSTRAP_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Lando could not start its provider runtime, so provider diagnostics were skipped. Validate config.yml with `lando config validate`; repair it with `lando config edit`, or check `lando plugin list` for conflicting plugins.",
  command: "lando config validate",
};

export const resilientDoctorReport = Effect.fn("Doctor.resilientReport")(
  (options: DoctorOptions = {}): Effect.Effect<DoctorReport, never, RuntimeLayerFactory> =>
    interruptOnAbort(collectResilientDoctorReport(options), options.signal),
);

const collectResilientDoctorReport = Effect.fnUntraced(function* (
  options: DoctorOptions,
): Effect.fn.Return<DoctorReport, never, RuntimeLayerFactory | Scope.Scope> {
  const sourceEnv = { ...(options.env ?? process.env) };
  const { redactor } = yield* resolveSecretsRedactor({ sourceEnv });

  const runtimeLayerFactory = yield* RuntimeLayerFactory;
  const captured = yield* Effect.serviceOption(LandoConfigService.GlobalConfigSources);
  const configLayer = Option.isSome(captured)
    ? LandoConfigService.layerWith(captured.value)
    : LandoConfigService.layer;
  let configError: ConfigError | undefined;
  const config = yield* isolateDoctorSection({
    section: "global-config",
    effect: Layer.build(configLayer).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          configError = error;
        }),
      ),
    ),
    fallback: undefined,
    solutions: [
      {
        kind: "manual",
        description: "Repair global configuration before rerunning doctor.",
        command: "lando config validate",
      },
    ],
    redact: (value) => redactor.redactString(value),
    budgetMs: doctorSectionBudgetMs(sourceEnv),
  });
  if (config.value === undefined) {
    const filesystemWatch = yield* isolateDoctorSection({
      section: "filesystem-watch",
      effect: filesystemWatchDoctor(redactor.redactString, options.platform),
      fallback: [],
      budgetMs: doctorSectionBudgetMs(sourceEnv),
      redact: redactor.redactString,
    });
    return {
      version: CORE_VERSION,
      globalConfig: { status: "fail", ...(configError === undefined ? {} : { error: configError }) },
      skipped: [
        "provider",
        "subsystems",
        "network-trust",
        "certificate-authority",
        "global-app",
        "mcp",
        ...(options.app ? ["app-config", "app-version-constraints"] : []),
        ...(options.deprecations ? ["deprecations"] : []),
      ].map((section) => ({
        section,
        status: "skipped" as const,
        reason:
          section === "subsystems"
            ? "Config-dependent subsystem checks require a passing global-config check; filesystem-watch ran independently."
            : "Requires the runtime built from a passing global-config check.",
      })),
      provider: { checks: [] },
      subsystems: { checks: filesystemWatch.value },
      globalApp: { checks: [] },
      mcp: { checks: [] },
      self: {
        checks: [
          ...(config.self === undefined ? [] : [config.self]),
          ...(filesystemWatch.self === undefined ? [] : [filesystemWatch.self]),
        ],
      },
    };
  }
  const snapshot = Context.get(config.value, LandoConfigService.GlobalConfigSnapshot);
  for (const message of yield* snapshot.takeWarnings)
    yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
  const runtime = runtimeLayerFactory.make(
    cliRuntimeOptions({ bootstrap: "provider", telemetry: false, plugins: { policy: "discovery" } }),
    snapshot,
  );
  const built = yield* isolateDoctorSection({
    section: "provider-bootstrap",
    effect: Layer.build(runtime).pipe(Effect.provide(config.value)),
    fallback: undefined,
    budgetMs: doctorSectionBudgetMs(sourceEnv),
    redact: (value) => redactor.redactString(value),
    solutions: [BOOTSTRAP_REMEDIATION],
  });
  const context = built.value;

  const report = yield* collectDoctorReport({
    options,
    appConfig:
      context === undefined ? Effect.succeed(undefined) : appConfigForReport().pipe(Effect.provide(context)),
    certs:
      context === undefined
        ? Effect.succeed(UNRESOLVED_CERTS_STATUS)
        : certsDoctorStatus(redactor.redactString).pipe(Effect.provide(context)),
    provider:
      context === undefined ? Effect.succeed({ checks: [] }) : doctor(options).pipe(Effect.provide(context)),
    deprecations:
      context === undefined
        ? Effect.succeed({ entries: [] })
        : doctorDeprecations().pipe(Effect.provide(context)),
    ...(context === undefined
      ? {}
      : {
          // First provide in the pipe wins: selected Traefik/SSH overlay the
          // unavailable stubs in DefaultSubsystemDoctorLayer.
          subsystems: (subsystemOptions) =>
            subsystemDoctor(subsystemOptions).pipe(
              Effect.provide(context),
              Effect.provide(DefaultSubsystemDoctorLayer),
            ),
        }),
    ...(built.self === undefined ? {} : { initialSelfChecks: [built.self] }),
  }).pipe(Effect.provide(context ?? Context.empty()), Effect.provide(config.value));
  return { ...report, globalConfig: { status: "pass" } };
}, Effect.scoped);
