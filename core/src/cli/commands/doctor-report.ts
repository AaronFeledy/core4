/**
 * Combined `lando doctor` report.
 *
 * Merges provider, subsystem, and global-app diagnostics into a single report
 * without requiring app bootstrap.
 */
import { Effect, Option } from "effect";

import type { ConfigLintResult } from "@lando/sdk/schema";
import { type ConfigService, DeprecationService, type RuntimeProviderRegistry } from "@lando/sdk/services";

import { lintLandofile } from "../../landofile/lint.ts";
import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import { DefaultGlobalAppDoctorLayer, globalAppDoctor } from "./doctor-global-app.ts";
import { DefaultMcpDoctorLayer, mcpDoctor } from "./doctor-mcp.ts";
import type {
  DoctorDeprecationEntry,
  DoctorDeprecationReport,
  DoctorReport,
} from "./doctor-report-contract.ts";
import { type DoctorSelfCheck, doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self.ts";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "./doctor-subsystems.ts";
import { appVersionConstraintsForReport } from "./doctor-version-constraint.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";

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

const doctorDeprecations = (): Effect.Effect<DoctorDeprecationReport, never, never> =>
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
 * Build the combined report with every section isolated.
 *
 * The error channel is `never` by construction: a section that fails, dies, or
 * overruns its deadline degrades to a fallback and contributes a `self` check,
 * so `lando doctor` always answers with a structured report. Only a user
 * interrupt stops the run.
 */
export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, never, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const sourceEnv = { ...(options.env ?? process.env) };
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redactionService)
      ? yield* redactionService.value.forProfile("secrets", { sourceEnv })
      : createStandaloneRedactor("secrets", { sourceEnv });
    const redact = (value: string): string => redactor.redactString(value);
    const budgetMs = doctorSectionBudgetMs(sourceEnv);
    const selfChecks: DoctorSelfCheck[] = [];

    const section = <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
      fallback: A,
    ): Effect.Effect<A, never, R> =>
      isolateDoctorSection({ section: name, effect, fallback, budgetMs, redact }).pipe(
        Effect.map((outcome) => {
          if (outcome.self !== undefined) selfChecks.push(outcome.self);
          return outcome.value;
        }),
      );

    const provider = yield* section("provider", doctor(options), EMPTY_CHECKS);
    // Provider-section self checks are lifted here so the report has one home for them.
    selfChecks.push(...(provider.selfChecks ?? []));
    const subsystems = yield* section(
      "subsystems",
      subsystemDoctor({ fix: options.fix === true }).pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
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
        ? yield* section("deprecations", doctorDeprecations(), { entries: [] })
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
  });
