import { recordConfigWarning } from "@lando/engine/config/config-warnings";
import { hostEventsShellConfigError } from "@lando/engine/config/global-config";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import * as LandoConfigService from "@lando/engine/services/config";
import { ConfigError } from "@lando/sdk/errors";
import * as StateStore from "@lando/state-store/service";
import { Context, Effect, Layer, Option, Result, Schema, type Scope } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import type { DoctorOptions } from "./doctor";
import { interruptOnAbort } from "./doctor-abort";
import type {
  DoctorFinding,
  DoctorReport,
  DoctorSectionFinding,
  DoctorSectionId,
  DoctorSolution,
} from "./doctor-contract";
import { HostDnsResolver } from "./doctor-host-dns";
import { collectDoctorReport } from "./doctor-report";
import {
  type DoctorContexts,
  doctorSections,
  selectedDoctorSections,
  wantsDoctorRuntime,
} from "./doctor-sections";
import { doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
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
    return { name: "global-config", status: "pass", severity: "info", context: {}, solutions: [] };
  return {
    name: "global-config",
    status: "fail",
    severity: "error",
    context: {
      message: redact(error.message),
      ...(error.path === undefined ? {} : { path: redact(error.path) }),
    },
    solutions: [{ kind: "manual", description: redact(error.remediation), command: "lando config validate" }],
    details: Schema.encodeSync(ConfigError)(error),
  };
};

const withSection = (section: DoctorSectionId, finding: DoctorFinding): DoctorSectionFinding => ({
  section,
  ...finding,
});

const collectResilientDoctorReport = Effect.fnUntraced(function* (
  options: DoctorOptions,
): Effect.fn.Return<DoctorReport, never, RuntimeLayerFactory | Scope.Scope> {
  const sourceEnv = { ...(options.env ?? (yield* CliInvocation).env) };
  const { redactor } = yield* resolveSecretsRedactor({ sourceEnv });
  const redact = redactor.redactString;
  const budgetMs = doctorSectionBudgetMs(sourceEnv);
  const table = doctorSections({ options, sourceEnv, budgetMs, redact });
  const captured = yield* Effect.serviceOption(LandoConfigService.GlobalConfigSources);
  const configLayer = Option.isSome(captured)
    ? LandoConfigService.layerWith(captured.value)
    : LandoConfigService.layer;
  const config = yield* isolateDoctorSection({
    section: "global-config",
    effect: Effect.result(Layer.build(configLayer)),
    fallback: undefined,
    budgetMs,
    redact,
    solutions: [
      {
        kind: "manual",
        description: "Repair global configuration before rerunning doctor.",
        command: "lando config validate",
      },
    ],
  });
  let contexts: DoctorContexts = {};
  const initialChecks: DoctorSectionFinding[] = config.self === undefined ? [] : [config.self];
  const configResult = config.value;
  if (configResult !== undefined) {
    if (Result.isFailure(configResult)) {
      initialChecks.push(withSection("global-config", globalConfigFinding(configResult.failure, redact)));
    } else {
      const snapshot = Context.get(configResult.success, LandoConfigService.GlobalConfigSnapshot);
      for (const message of yield* snapshot.takeWarnings)
        yield* recordConfigWarning({ code: "LANDO_MESSAGE_WARN", message });
      const resolver = yield* Effect.serviceOption(HostDnsResolver);
      const dnsLayer = Option.isSome(resolver)
        ? Layer.succeed(HostDnsResolver, resolver.value)
        : HostDnsResolver.layer;
      const support = yield* Layer.build(Layer.merge(StateStore.layer, dnsLayer)).pipe(
        Effect.provide(configResult.success),
      );
      const configContext = Context.merge(configResult.success, support);
      contexts = { config: configContext };
      const hostEventsError = hostEventsShellConfigError(
        snapshot.config.hostEvents,
        snapshot.paths.configFile,
      );
      initialChecks.push(withSection("global-config", globalConfigFinding(hostEventsError, redact)));
      if (selectedDoctorSections(table, options).some(wantsDoctorRuntime)) {
        const runtimeLayerFactory = yield* RuntimeLayerFactory;
        const runtime = runtimeLayerFactory.make(
          cliRuntimeOptions({ bootstrap: "provider", telemetry: false, plugins: { policy: "discovery" } }),
          snapshot,
        );
        const built = yield* isolateDoctorSection({
          section: "provider",
          probe: "provider-bootstrap",
          effect: Layer.build(runtime).pipe(Effect.provide(configContext)),
          fallback: undefined,
          budgetMs,
          redact,
          solutions: [BOOTSTRAP_REMEDIATION],
        });
        if (built.self !== undefined) initialChecks.push(built.self);
        if (built.value !== undefined)
          contexts = { config: configContext, runtime: Context.merge(configContext, built.value) };
      }
    }
  }
  return yield* collectDoctorReport({ options, contexts, initialChecks });
}, Effect.scoped);
