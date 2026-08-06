/**
 * Combined `lando doctor` report.
 *
 * Merges provider, subsystem, and global-app diagnostics into a single report
 * without requiring app bootstrap.
 */
import { Effect, Option } from "effect";

import type { ConfigLintResult } from "@lando/sdk/schema";
import { type ConfigService, DeprecationService, type RuntimeProviderRegistry } from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import { lintLandofile } from "../../services/landofile-live.ts";
import { interruptOnAbort } from "./doctor-abort.ts";
import { type CertsDoctorStatus, UNRESOLVED_CERTS_STATUS, certsDoctorStatus } from "./doctor-certs-status.ts";
import { DefaultGlobalAppDoctorLayer, globalAppDoctor } from "./doctor-global-app.ts";
import { DefaultMcpDoctorLayer, mcpDoctor } from "./doctor-mcp.ts";
import { type NetworkTrustDoctorStatus, networkTrustDoctorStatus } from "./doctor-network-trust.ts";
import type {
  DoctorDeprecationEntry,
  DoctorDeprecationReport,
  DoctorReport,
} from "./doctor-report-contract.ts";
import { type DoctorSelfCheck, doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self.ts";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "./doctor-subsystems.ts";
import { appVersionConstraintsForReport } from "./doctor-version-constraint.ts";
import { type DoctorOptions, type DoctorResult, doctor } from "./doctor.ts";

export type {
  DoctorDeprecationEntry,
  DoctorDeprecationReport,
  DoctorReport,
} from "./doctor-report-contract.ts";
export { DoctorReportSchema } from "./doctor-report-contract.ts";
export {
  buildDoctorReportSummary,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
  renderDoctorReportAsYaml,
} from "./doctor-report-render.ts";

const appConfigForReport = (): Effect.Effect<ConfigLintResult, never, never> =>
  lintLandofile().pipe(
    Effect.catchTag("LandofileNotFoundError", (error) =>
      Effect.succeed({
        app: "",
        file: "(none)",
        valid: false,
        violations: [{ path: "", message: error.message }],
      } satisfies ConfigLintResult),
    ),
    Effect.catchTag("LandofileFormConflictError", (error) =>
      Effect.succeed({
        app: "",
        file: error.yamlPath,
        valid: false,
        violations: [{ path: "", message: error.message }],
      } satisfies ConfigLintResult),
    ),
  );

const sourceForDeprecation = (entry: {
  readonly app?: string | undefined;
  readonly plugin?: string | undefined;
}): string => {
  if (entry.plugin !== undefined && entry.plugin.length > 0) return `plugin:${entry.plugin}`;
  if (entry.app !== undefined && entry.app.length > 0) return `app:${entry.app}`;
  return "core";
};

export const doctorDeprecations = (): Effect.Effect<DoctorDeprecationReport, never, never> =>
  Effect.gen(function* () {
    const maybeDeprecations = yield* Effect.serviceOption(DeprecationService);
    if (Option.isNone(maybeDeprecations)) return { entries: [] };
    const deprecations = maybeDeprecations.value;
    const summary = yield* deprecations.summary();
    const entries: DoctorDeprecationEntry[] = [];
    for (const entry of summary) {
      const lookup = yield* deprecations.lookup(entry.kind, entry.id);
      const notice = Option.getOrElse(lookup, () => entry.notice);
      entries.push({
        kind: entry.kind,
        id: entry.id,
        severity: notice.severity,
        since: notice.since,
        ...(notice.removeIn === undefined ? {} : { removeIn: notice.removeIn }),
        ...(notice.replacement === undefined ? {} : { replacement: notice.replacement }),
        note: notice.note,
        ...(notice.docsUrl === undefined ? {} : { docsUrl: notice.docsUrl }),
        source: sourceForDeprecation(entry),
        count: entry.count,
      });
    }
    entries.sort((left, right) =>
      left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind),
    );
    return { entries };
  });

const EMPTY_CHECKS = { checks: [] } as const;

/**
 * Inputs for the section collector. Callers inject the runtime-dependent
 * sections so the same collection logic serves a provided runtime and the
 * self-provisioning CLI path that may have no runtime at all.
 */
export interface CollectDoctorReportInput<R> {
  readonly options: DoctorOptions;
  readonly provider: Effect.Effect<DoctorResult, never, R>;
  readonly deprecations: Effect.Effect<DoctorDeprecationReport, never, R>;
  readonly certs?: Effect.Effect<CertsDoctorStatus, never, R>;
  /** Self checks recorded before collection started (e.g. bootstrap failure). */
  readonly initialSelfChecks?: ReadonlyArray<DoctorSelfCheck>;
}

export const collectDoctorReport = <R>(
  input: CollectDoctorReportInput<R>,
): Effect.Effect<DoctorReport, never, R | ConfigService> =>
  Effect.gen(function* () {
    const options = input.options;
    const sourceEnv = { ...(options.env ?? process.env) };
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redactionService)
      ? yield* redactionService.value.forProfile("secrets", { sourceEnv })
      : createStandaloneRedactor("secrets", { sourceEnv });
    const redact = (value: string): string => redactor.redactString(value);
    const budgetMs = doctorSectionBudgetMs(sourceEnv);
    const selfChecks: DoctorSelfCheck[] = [...(input.initialSelfChecks ?? [])];

    const section = <A, E, SR>(
      name: string,
      effect: Effect.Effect<A, E, SR>,
      fallback: A,
    ): Effect.Effect<A, never, SR> =>
      isolateDoctorSection({ section: name, effect, fallback, budgetMs, redact }).pipe(
        Effect.map((outcome) => {
          if (outcome.self !== undefined) selfChecks.push(outcome.self);
          return outcome.value;
        }),
      );

    const provider = yield* section("provider", input.provider, EMPTY_CHECKS);
    // Provider-section self checks are lifted here so the report has one home for them.
    selfChecks.push(...(provider.selfChecks ?? []));
    const certs = yield* section(
      "certificate-authority",
      input.certs ?? certsDoctorStatus(redact),
      UNRESOLVED_CERTS_STATUS,
    );
    const networkTrust = yield* section<NetworkTrustDoctorStatus | undefined, unknown, ConfigService>(
      "network-trust",
      networkTrustDoctorStatus(sourceEnv),
      undefined,
    );
    const subsystems = yield* section(
      "subsystems",
      subsystemDoctor({
        fix: options.fix === true,
        certs,
        ...(networkTrust === undefined ? {} : { networkTrust }),
      }).pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
      EMPTY_CHECKS,
    );
    const globalApp = yield* section(
      "global-app",
      globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer)),
      EMPTY_CHECKS,
    );
    const mcp = yield* section("mcp", mcpDoctor().pipe(Effect.provide(DefaultMcpDoctorLayer)), EMPTY_CHECKS);
    const appVersionConstraints =
      options.app === true
        ? yield* section("app-version-constraints", appVersionConstraintsForReport(), EMPTY_CHECKS)
        : undefined;
    const deprecations =
      options.deprecations === true
        ? yield* section("deprecations", input.deprecations, { entries: [] })
        : undefined;
    const appConfig =
      options.app === true ? yield* section("app-config", appConfigForReport(), undefined) : undefined;
    return {
      provider: { checks: provider.checks },
      subsystems,
      globalApp,
      mcp,
      ...(appVersionConstraints === undefined ? {} : { appVersionConstraints }),
      ...(deprecations === undefined ? {} : { deprecations }),
      ...(appConfig === undefined ? {} : { appConfig }),
      ...(selfChecks.length === 0 ? {} : { self: { checks: selfChecks } }),
    };
  }).pipe((effect) => interruptOnAbort(effect, input.options.signal));

/**
 * Build the combined report against an already-provided runtime.
 *
 * The error channel is `never` by construction: a section that fails, dies, or
 * overruns its deadline degrades to a fallback and contributes a `self` check,
 * so `lando doctor` always answers with a structured report. Only a user
 * interrupt stops the run.
 */
export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, never, ConfigService | RuntimeProviderRegistry> =>
  collectDoctorReport({ options, provider: doctor(options), deprecations: doctorDeprecations() });
