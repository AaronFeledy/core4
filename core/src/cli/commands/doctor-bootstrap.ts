/**
 * Safe-mode `lando doctor` entry point.
 *
 * `meta:doctor` validates global config before building the provider runtime.
 * An expected `ConfigError` is a diagnosis (a failing `global-config` finding);
 * only a defect or timeout becomes a `doctor-self`. Invalid config skips
 * dependent sections while independent diagnostics continue.
 *
 * The runtime is built exactly once, inside a `Scope` that stays open for the
 * runtime-dependent sections and closes with the report.
 */
import { recordConfigWarning } from "@lando/engine/config/config-warnings";
import { hostEventsShellConfigError } from "@lando/engine/config/global-config";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import * as LandoConfigService from "@lando/engine/services/config";
import { ConfigError } from "@lando/sdk/errors";
import * as StateStore from "@lando/state-store/service";
import { Context, Effect, Layer, Option, Result, Schema, type Scope } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import { type DoctorOptions, type DoctorSectionResult, doctor } from "./doctor";
import { interruptOnAbort } from "./doctor-abort";
import { UNRESOLVED_CERTS_STATUS, certsDoctorStatus } from "./doctor-certs-status";
import type {
  DoctorCheck,
  DoctorFinding,
  DoctorReport,
  DoctorSectionId,
  DoctorSkip,
  DoctorSolution,
} from "./doctor-contract";
import { filesystemWatchDoctor } from "./doctor-filesystem-watch";
import { HostDnsResolver } from "./doctor-host-dns";
import { buildHostDnsCheck } from "./doctor-host-dns-check";
import { listenerDoctorChecks } from "./doctor-listeners";
import {
  appConfigForReport,
  collectDoctorReport,
  doctorDeprecations,
  makeDoctorReport,
  runDoctorSection,
} from "./doctor-report";
import { doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
import { subsystemDoctor } from "./doctor-subsystems";
import { resolveSecretsRedactor } from "./secrets-redactor";

const BOOTSTRAP_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "Lando could not start its provider runtime, so provider diagnostics were skipped. Validate config.yml with `lando config validate`; repair it with `lando config edit`, or remove a conflicting plugin with `lando plugin:remove <name>` and reinstall it with `lando plugin:add <spec>`.",
  command: "lando config validate",
};

export const resilientDoctorReport = Effect.fn("Doctor.resilientReport")(
  (options: DoctorOptions = {}): Effect.Effect<DoctorReport, never, RuntimeLayerFactory> =>
    interruptOnAbort(collectResilientDoctorReport(options), options.signal),
);

const globalConfigFinding = (
  error: ConfigError | undefined,
  redact: (value: string) => string,
): DoctorFinding => {
  if (error === undefined)
    return {
      name: "global-config",
      status: "pass",
      severity: "info",
      context: {},
      solutions: [],
    };
  return {
    name: "global-config",
    status: "fail",
    severity: "error",
    context: {
      message: redact(error.message),
      ...(error.path === undefined ? {} : { path: redact(error.path) }),
    },
    solutions: [
      {
        kind: "manual",
        description: redact(error.remediation),
        command: "lando config validate",
      },
    ],
    details: Schema.encodeSync(ConfigError)(error),
  };
};

const withSection = (section: DoctorSectionId, finding: DoctorFinding): DoctorCheck => ({
  section,
  ...finding,
});

const configDependentSkipped = (options: DoctorOptions, reason: string): ReadonlyArray<DoctorSkip> => {
  const sections: ReadonlyArray<DoctorSectionId> = [
    "provider",
    "certificate-authority",
    "network-trust",
    "subsystems",
    "global-app",
    "mcp",
    "accelerated-starts",
    "missing-app-roots",
    "orphaned-volume-snapshots",
    "legacy-snapshot-catalogs",
    "debugger-host",
    ...(options.app === true ? (["app-config", "app-version-constraints", "app-listeners"] as const) : []),
    ...(options.deprecations === true ? (["deprecations"] as const) : []),
  ];
  return sections.map((section) => ({
    section,
    reason:
      section === "subsystems"
        ? "Config-dependent subsystem checks require a passing global-config check; filesystem-watch ran independently."
        : reason,
  }));
};

const collectResilientDoctorReport = Effect.fnUntraced(function* (
  options: DoctorOptions,
): Effect.fn.Return<DoctorReport, never, RuntimeLayerFactory | Scope.Scope> {
  const sourceEnv = { ...(options.env ?? (yield* CliInvocation).env) };
  const { redactor } = yield* resolveSecretsRedactor({ sourceEnv });
  const budgetMs = doctorSectionBudgetMs(sourceEnv);

  const runtimeLayerFactory = yield* RuntimeLayerFactory;
  const captured = yield* Effect.serviceOption(LandoConfigService.GlobalConfigSources);
  const configLayer = Option.isSome(captured)
    ? LandoConfigService.layerWith(captured.value)
    : LandoConfigService.layer;
  const config = yield* isolateDoctorSection({
    section: "global-config",
    effect: Effect.result(Layer.build(configLayer)),
    fallback: undefined,
    budgetMs,
    redact: (value) => redactor.redactString(value),
    solutions: [
      {
        kind: "manual",
        description: "Repair global configuration before rerunning doctor.",
        command: "lando config validate",
      },
    ],
  });
  const configResult = config.value;
  if (configResult === undefined || Result.isFailure(configResult)) {
    const filesystemWatch = yield* runDoctorSection(
      {
        id: "filesystem-watch",
        run: filesystemWatchDoctor(redactor.redactString, options.platform).pipe(
          Effect.map((findings): DoctorSectionResult => ({ checks: findings })),
        ),
      },
      { budgetMs, redact: redactor.redactString },
    );
    const failure =
      configResult === undefined
        ? []
        : [withSection("global-config", globalConfigFinding(configResult.failure, redactor.redactString))];
    return makeDoctorReport({
      checks: [...failure, ...(config.self === undefined ? [] : [config.self]), ...filesystemWatch.checks],
      skipped: [
        ...configDependentSkipped(options, "Requires the runtime built from a passing global-config check."),
        ...filesystemWatch.skipped,
      ],
    });
  }

  const snapshot = Context.get(configResult.success, LandoConfigService.GlobalConfigSnapshot);
  for (const message of yield* snapshot.takeWarnings)
    yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
  const runtime = runtimeLayerFactory.make(
    cliRuntimeOptions({ bootstrap: "provider", telemetry: false, plugins: { policy: "discovery" } }),
    snapshot,
  );
  const built = yield* isolateDoctorSection({
    section: "provider",
    probe: "provider-bootstrap",
    effect: Layer.build(runtime).pipe(Effect.provide(configResult.success)),
    fallback: undefined,
    budgetMs,
    redact: (value) => redactor.redactString(value),
    solutions: [BOOTSTRAP_REMEDIATION],
  });
  const context = built.value;
  const resolver = yield* Effect.serviceOption(HostDnsResolver);
  const dnsLayer = Option.isSome(resolver)
    ? Layer.succeed(HostDnsResolver, resolver.value)
    : HostDnsResolver.layer;
  const reportContext: Context.Context<never> =
    context ?? (yield* Layer.build(StateStore.layer).pipe(Effect.provide(configResult.success)));
  const skipped: ReadonlyArray<DoctorSkip> | undefined =
    context === undefined
      ? (
          [
            { section: "provider" },
            { section: "subsystems", check: "router" },
            { section: "subsystems", check: "ssh" },
            { section: "subsystems", check: "healthcheck" },
            { section: "subsystems", check: "scanner" },
            { section: "certificate-authority" },
            { section: "missing-app-roots" },
            { section: "orphaned-volume-snapshots" },
            ...(options.app === true
              ? ([{ section: "app-config" }, { section: "app-listeners" }] as const)
              : []),
            ...(options.deprecations === true ? ([{ section: "deprecations" }] as const) : []),
          ] satisfies ReadonlyArray<Omit<DoctorSkip, "reason">>
        ).map((entry) => ({
          ...entry,
          reason: "Requires the provider runtime; see the provider-bootstrap self check.",
        }))
      : undefined;

  const hostEventsError = hostEventsShellConfigError(snapshot.config.hostEvents, snapshot.paths.configFile);
  const initialChecks: ReadonlyArray<DoctorCheck> = [
    withSection("global-config", globalConfigFinding(hostEventsError, redactor.redactString)),
    ...(built.self === undefined ? [] : [built.self]),
  ];
  return yield* collectDoctorReport({
    options,
    ...(context === undefined ? {} : { appConfig: appConfigForReport().pipe(Effect.provide(context)) }),
    certs:
      context === undefined
        ? Effect.succeed(UNRESOLVED_CERTS_STATUS)
        : certsDoctorStatus(redactor.redactString).pipe(Effect.provide(context)),
    provider:
      context === undefined ? Effect.succeed({ checks: [] }) : doctor(options).pipe(Effect.provide(context)),
    ...(context === undefined
      ? {}
      : {
          listeners: (input: Parameters<typeof listenerDoctorChecks>[0]) =>
            listenerDoctorChecks(input).pipe(Effect.provide(context)),
        }),
    deprecations:
      context === undefined
        ? Effect.succeed({ entries: [] })
        : doctorDeprecations().pipe(Effect.provide(context)),
    subsystems: (subsystemOptions) =>
      (context === undefined
        ? buildHostDnsCheck(options.fix === true).pipe(
            Effect.map((check): DoctorSectionResult => ({ checks: [check] })),
          )
        : subsystemDoctor(subsystemOptions).pipe(Effect.provide(context))
      ).pipe(Effect.provide(dnsLayer)),
    initialChecks,
    ...(skipped === undefined ? {} : { skipped }),
  }).pipe(Effect.provide(reportContext), Effect.provide(configResult.success));
}, Effect.scoped);
