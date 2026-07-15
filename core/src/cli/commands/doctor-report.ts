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
import { DefaultGlobalAppDoctorLayer, globalAppDoctor } from "./doctor-global-app.ts";
import { DefaultMcpDoctorLayer, mcpDoctor } from "./doctor-mcp.ts";
import type {
  DoctorDeprecationEntry,
  DoctorDeprecationReport,
  DoctorReport,
} from "./doctor-report-contract.ts";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "./doctor-subsystems.ts";
import { appVersionConstraintsForReport } from "./doctor-version-constraint.ts";
import { type DoctorError, type DoctorOptions, doctor } from "./doctor.ts";

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

export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const provider = yield* doctor(options);
    const subsystems = yield* subsystemDoctor({ fix: options.fix === true }).pipe(
      Effect.provide(DefaultSubsystemDoctorLayer),
    );
    const globalApp = yield* globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer));
    const mcp = yield* mcpDoctor().pipe(Effect.provide(DefaultMcpDoctorLayer));
    const appVersionConstraints = options.app === true ? yield* appVersionConstraintsForReport() : undefined;
    const deprecations = options.deprecations === true ? yield* doctorDeprecations() : undefined;
    const appConfig = options.app === true ? yield* appConfigForReport() : undefined;
    return {
      provider,
      subsystems,
      globalApp,
      mcp,
      ...(appVersionConstraints === undefined ? {} : { appVersionConstraints }),
      ...(deprecations === undefined ? {} : { deprecations }),
      ...(appConfig === undefined ? {} : { appConfig }),
    };
  });
