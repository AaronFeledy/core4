/**
 * Combined `lando doctor` report.
 *
 * One table drives collection, the live task tree, and report order. Producers
 * are section-agnostic; this module stamps the section onto every finding and
 * skip, builds the report once with the pure `makeDoctorReport`, and owns the
 * single counting-by-completion policy.
 */
import { join } from "node:path";
import { appConfigLint } from "@lando/engine/operations/app-config-lint";
import { findAppRoot } from "@lando/landofile/discovery";
import {
  type ConfigLintResult,
  type ConfigLintViolation,
  DeprecationSeverity,
  DeprecationSurfaceKind,
  MAILHOG_DEPRECATION_NOTICE,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import {
  type ConfigService,
  DeprecationService,
  FileSystem,
  type PathsService,
  type PluginRegistry,
  RouterService,
  type RuntimeProviderRegistry,
  SshService,
} from "@lando/sdk/services";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import { type DoctorOptions, type DoctorSectionResult, doctor } from "./doctor";
import { interruptOnAbort } from "./doctor-abort";
import { acceleratedStartsDoctor } from "./doctor-accelerated-starts";
import { type CertsDoctorStatus, certsDoctorStatus, certsSubsystemCheck } from "./doctor-certs-status";
import type {
  DoctorCheck,
  DoctorFinding,
  DoctorProvider,
  DoctorReport,
  DoctorSectionId,
  DoctorSkip,
  DoctorSkipInput,
} from "./doctor-contract";
import { debuggerHostDoctor } from "./doctor-debugger";
import { filesystemWatchDoctor } from "./doctor-filesystem-watch";
import { DefaultGlobalAppDoctorLayer, globalAppDoctor } from "./doctor-global-app";
import { HostDnsResolver } from "./doctor-host-dns";
import { legacySnapshotCatalogsDoctor } from "./doctor-legacy-snapshot-catalogs";
import { listenerDoctorChecks } from "./doctor-listeners";
import { DefaultMcpDoctorLayer, mcpDoctor } from "./doctor-mcp";
import { missingAppRootsDoctor } from "./doctor-missing-app-roots";
import { networkTrustDoctorStatus } from "./doctor-network-trust";
import { orphanedSnapshotsDoctor } from "./doctor-orphaned-snapshots";
import {
  type DoctorSectionOutcome,
  checksOutcome,
  doctorTreeSummary,
  makeDoctorTree,
  settleDoctorSection,
} from "./doctor-progress";
import { makeDoctorReport } from "./doctor-report-model";
import { doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
import { type SubsystemDoctorOptions, subsystemDoctor } from "./doctor-subsystems";
import { appVersionConstraintsForReport } from "./doctor-version-constraint";
import { resolveSecretsRedactor } from "./secrets-redactor";

export type { DoctorReport } from "./doctor-contract";
export { DoctorReportSchema } from "./doctor-contract";
export { renderDoctorReportAsNdjson } from "./doctor-render-ndjson";
export {
  type DoctorRenderOptions,
  buildDoctorReportSummary,
  renderDoctorReport,
} from "./doctor-render-text";

export const appConfigForReport = () =>
  appConfigLint().pipe(
    Effect.catchTag("LandofileNotFoundError", (error) =>
      Effect.succeed({
        app: "",
        file: "(none)",
        valid: false,
        violations: [
          {
            rule: "landofile.discovery",
            severity: "error",
            path: [],
            scopes: ["fragment"],
            message: error.message,
          },
        ],
      } satisfies ConfigLintResult),
    ),
    Effect.catchTag("LandofileFormConflictError", (error) =>
      Effect.succeed({
        app: "",
        file: error.yamlPath,
        valid: false,
        violations: [
          {
            rule: "landofile.discovery",
            severity: "error",
            path: [],
            scopes: ["fragment"],
            message: error.message,
          },
        ],
      } satisfies ConfigLintResult),
    ),
  );

export const DoctorDeprecationEntry = Schema.Struct({
  kind: DeprecationSurfaceKind,
  id: Schema.String,
  severity: DeprecationSeverity,
  since: Schema.String,
  removeIn: Schema.optionalKey(Schema.String),
  replacement: Schema.optionalKey(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optionalKey(Schema.String),
  source: Schema.String,
  count: Schema.Number,
});
export type DoctorDeprecationEntry = typeof DoctorDeprecationEntry.Type;

export const DoctorDeprecationReport = Schema.Struct({
  entries: Schema.Array(DoctorDeprecationEntry),
});
export type DoctorDeprecationReport = typeof DoctorDeprecationReport.Type;

const sourceForDeprecation = (entry: {
  readonly app?: string | undefined;
  readonly plugin?: string | undefined;
}): string => {
  if (entry.plugin !== undefined && entry.plugin.length > 0) return `plugin:${entry.plugin}`;
  if (entry.app !== undefined && entry.app.length > 0) return `app:${entry.app}`;
  return "core";
};

const MAILHOG_TYPE = /(?:^|[\r\n])[ \t]*type:[ \t]*["']?mailhog["']?(?:[ \t]+#.*)?[ \t]*(?:\r?\n|$)/;

const recordAuthoredMailhogUse = Effect.gen(function* () {
  const maybeDeprecations = yield* Effect.serviceOption(DeprecationService);
  const maybeFs = yield* Effect.serviceOption(FileSystem);
  if (Option.isNone(maybeDeprecations) || Option.isNone(maybeFs)) return;
  const appRoot = yield* findAppRoot();
  if (appRoot === undefined) return;
  for (const name of [".lando.yml", ".lando.yaml"] as const) {
    const path = join(appRoot, name);
    const exists = yield* maybeFs.value.exists(path).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!exists) continue;
    const text = yield* maybeFs.value.readText(path).pipe(Effect.catch(() => Effect.succeed("")));
    if (MAILHOG_TYPE.test(text)) {
      yield* maybeDeprecations.value
        .use({
          kind: "service-type",
          id: "mailhog",
          notice: MAILHOG_DEPRECATION_NOTICE,
          timestamp: DateTime.nowUnsafe(),
        })
        .pipe(Effect.catch(() => Effect.void));
    }
    return;
  }
});

export const doctorDeprecations = Effect.fnUntraced(function* (): Effect.fn.Return<
  DoctorDeprecationReport,
  never,
  never
> {
  yield* recordAuthoredMailhogUse;
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

/** Each deprecation entry counts once; occurrences stay in `context.count`. */
export const deprecationFindings = (report: DoctorDeprecationReport): ReadonlyArray<DoctorFinding> =>
  report.entries.map((entry) => ({
    name: "deprecation",
    status: ({ error: "fail", warn: "warn", info: "pass" } as const)[entry.severity],
    severity: entry.severity,
    context: {
      kind: entry.kind,
      id: entry.id,
      since: entry.since,
      ...(entry.removeIn === undefined ? {} : { removeIn: entry.removeIn }),
      ...(entry.replacement === undefined ? {} : { replacement: entry.replacement }),
      ...(entry.docsUrl === undefined ? {} : { docsUrl: entry.docsUrl }),
      source: entry.source,
      count: String(entry.count),
    },
    solutions: [{ kind: "manual", description: entry.note }],
  }));

const violationLocation = (violation: ConfigLintViolation): string => {
  const formatted = formatValidationIssuePath(violation.path);
  return formatted.length === 0 ? "(root)" : formatted;
};

export const appConfigFindings = (result: ConfigLintResult): ReadonlyArray<DoctorFinding> => {
  if (result.violations.length === 0)
    return [
      {
        name: "app-config-lint",
        status: "pass",
        severity: "info",
        context: { file: result.file },
        solutions: [],
      },
    ];
  return result.violations.map((violation) => ({
    name: violation.rule,
    status: violation.severity === "error" ? "fail" : "warn",
    severity: violation.severity === "error" ? "error" : "warn",
    context: {
      file: result.file,
      location: violationLocation(violation),
      message: violation.message,
      ...(violation.reason === undefined ? {} : { reason: violation.reason }),
      ...(violation.line === undefined ? {} : { line: String(violation.line) }),
      ...(violation.column === undefined ? {} : { column: String(violation.column) }),
      ...(violation.source === undefined ? {} : { source: violation.source.layer }),
    },
    solutions:
      violation.suggestion === undefined ? [] : [{ kind: "manual", description: violation.suggestion }],
    details: violation,
  }));
};

export {
  doctorCompletion,
  makeDoctorReport,
  summarizeDoctorChecks,
} from "./doctor-report-model";

interface DoctorSectionBase {
  readonly id: DoctorSectionId;
  readonly when?: (options: DoctorOptions) => boolean;
}

/**
 * One table entry. An isolated section may fail; the runner degrades it to a
 * self finding. A section that owns its isolation must be infallible, so a user
 * interrupt stays an interrupt instead of becoming a defect.
 */
export type DoctorSectionSpec<R> =
  | (DoctorSectionBase & {
      readonly run: Effect.Effect<DoctorSectionResult, unknown, R>;
      readonly isolate?: undefined;
    })
  | (DoctorSectionBase & {
      readonly run: Effect.Effect<DoctorSectionResult, never, R>;
      readonly isolate: false;
    });

export interface DoctorSectionOutput {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly skipped: ReadonlyArray<DoctorSkip>;
  readonly provider?: DoctorProvider;
}

const EMPTY_SECTION_RESULT: DoctorSectionResult = { checks: [] };

const stampSection = (section: DoctorSectionId, result: DoctorSectionResult): DoctorSectionOutput => ({
  checks: result.checks.map((finding) => ({ section, ...finding })),
  skipped: (result.skipped ?? []).map((skip) => ({ section, ...skip })),
  ...(result.provider === undefined ? {} : { provider: result.provider }),
});

/**
 * Run one table entry, isolate it unless it owns isolation, and stamp its
 * section onto every finding and skip. Generic over the entry's requirements so
 * the config-failure path can reuse it without a runtime or a tree.
 */
export const runDoctorSection = <R>(
  spec: DoctorSectionSpec<R>,
  input: { readonly budgetMs: number; readonly redact: (value: string) => string },
): Effect.Effect<DoctorSectionOutput, never, R> =>
  spec.isolate === false
    ? spec.run.pipe(Effect.map((result) => stampSection(spec.id, result)))
    : isolateDoctorSection({
        section: spec.id,
        effect: spec.run,
        fallback: EMPTY_SECTION_RESULT,
        budgetMs: input.budgetMs,
        redact: input.redact,
      }).pipe(
        Effect.map((isolated) => {
          const output = stampSection(spec.id, isolated.value);
          return isolated.self === undefined
            ? output
            : { ...output, checks: [...output.checks, isolated.self] };
        }),
      );

const sectionSpec = <R>(
  id: DoctorSectionId,
  run: Effect.Effect<DoctorSectionResult, unknown, R>,
  extra?: { readonly when?: (options: DoctorOptions) => boolean },
): DoctorSectionSpec<R> => (extra?.when === undefined ? { id, run } : { id, run, when: extra.when });

export interface CollectDoctorReportInput<R> {
  readonly options: DoctorOptions;
  readonly provider: Effect.Effect<DoctorSectionResult, never, R>;
  readonly listeners?: (input: {
    readonly budgetMs: number;
    readonly redact: (value: string) => string;
  }) => Effect.Effect<DoctorSectionResult, never, R>;
  readonly deprecations: Effect.Effect<DoctorDeprecationReport, never, R>;
  readonly certs?: Effect.Effect<CertsDoctorStatus, never, R>;
  readonly appConfig?: Effect.Effect<
    ConfigLintResult | undefined,
    Effect.Error<ReturnType<typeof appConfigForReport>>,
    R
  >;
  /**
   * Injected subsystem doctor. Callers that already built a provider runtime
   * provide the selected runtime services. Without them, the section is skipped.
   */
  readonly subsystems?: (options: SubsystemDoctorOptions) => Effect.Effect<DoctorSectionResult, never, R>;
  /** Findings recorded before collection started (global config, bootstrap). */
  readonly initialChecks?: ReadonlyArray<DoctorCheck>;
  readonly skipped?: ReadonlyArray<DoctorSkip>;
}

export const collectDoctorReport = Effect.fn("Doctor.collectReport")(
  <R>(input: CollectDoctorReportInput<R>): Effect.Effect<DoctorReport, never, R | ConfigService> =>
    collectWithTree(input).pipe((effect) => interruptOnAbort(effect, input.options.signal)),
);

const collectWithTree = Effect.fnUntraced(function* <R>(
  input: CollectDoctorReportInput<R>,
): Effect.fn.Return<DoctorReport, never, R | ConfigService> {
  const options = input.options;
  const sourceEnv = { ...(options.env ?? (yield* CliInvocation).env) };
  const { redact } = yield* resolveSecretsRedactor({ sourceEnv });
  const budgetMs = doctorSectionBudgetMs(sourceEnv);
  const checks: DoctorCheck[] = [...(input.initialChecks ?? [])];
  const skipped: DoctorSkip[] = [...(input.skipped ?? [])];
  if (input.subsystems === undefined && !skipped.some((entry) => entry.section === "subsystems")) {
    skipped.push({
      section: "subsystems",
      reason: "Runtime subsystem services were not provided; no subsystem inspection was performed.",
    });
  }

  const subsystemsRun: Effect.Effect<DoctorSectionResult, never, R> =
    input.subsystems === undefined
      ? Effect.succeed(EMPTY_SECTION_RESULT)
      : input.subsystems({ fix: options.fix === true });

  const certsRun = (input.certs ?? certsDoctorStatus(redact)).pipe(
    Effect.flatMap((status) => certsSubsystemCheck(status, options.fix === true)),
    Effect.map((check): DoctorSectionResult => ({ checks: check === undefined ? [] : [check] })),
  );

  const specs: ReadonlyArray<DoctorSectionSpec<R | ConfigService>> = [
    sectionSpec("provider", input.provider),
    {
      id: "app-listeners",
      when: (candidate) => candidate.app === true,
      isolate: false,
      run:
        input.listeners === undefined
          ? Effect.succeed({
              checks: [],
              skipped: [
                { reason: "Runtime listener inspection was not provided." } satisfies DoctorSkipInput,
              ],
            })
          : input.listeners({ budgetMs, redact }),
    },
    sectionSpec("certificate-authority", certsRun),
    sectionSpec(
      "network-trust",
      networkTrustDoctorStatus(sourceEnv).pipe(
        Effect.map((status): DoctorSectionResult => ({ checks: [status] })),
      ),
    ),
    sectionSpec("subsystems", subsystemsRun),
    sectionSpec("global-app", globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer))),
    sectionSpec("mcp", mcpDoctor().pipe(Effect.provide(DefaultMcpDoctorLayer))),
    sectionSpec(
      "accelerated-starts",
      acceleratedStartsDoctor(redact).pipe(
        Effect.map((findings): DoctorSectionResult => ({ checks: findings })),
      ),
    ),
    sectionSpec(
      "missing-app-roots",
      missingAppRootsDoctor(redact).pipe(
        Effect.map((findings): DoctorSectionResult => ({ checks: findings })),
      ),
    ),
    sectionSpec(
      "orphaned-volume-snapshots",
      orphanedSnapshotsDoctor(redact).pipe(
        Effect.map((findings): DoctorSectionResult => ({ checks: findings })),
      ),
    ),
    sectionSpec(
      "legacy-snapshot-catalogs",
      legacySnapshotCatalogsDoctor(redact).pipe(
        Effect.map((findings): DoctorSectionResult => ({ checks: findings })),
      ),
    ),
    sectionSpec(
      "filesystem-watch",
      filesystemWatchDoctor(redact, options.platform).pipe(
        Effect.map((findings): DoctorSectionResult => ({ checks: findings })),
      ),
    ),
    sectionSpec("debugger-host", debuggerHostDoctor(redact, budgetMs, options.platform)),
    sectionSpec(
      "app-version-constraints",
      appVersionConstraintsForReport().pipe(Effect.map((result) => result ?? EMPTY_SECTION_RESULT)),
      { when: (candidate) => candidate.app === true },
    ),
    sectionSpec(
      "deprecations",
      input.deprecations.pipe(
        Effect.map((report): DoctorSectionResult => ({ checks: deprecationFindings(report) })),
      ),
      { when: (candidate) => candidate.deprecations === true },
    ),
    sectionSpec(
      "app-config",
      input.appConfig === undefined
        ? Effect.succeed(EMPTY_SECTION_RESULT)
        : input.appConfig.pipe(
            Effect.map(
              (result): DoctorSectionResult => ({
                checks: result === undefined ? [] : appConfigFindings(result),
              }),
            ),
          ),
      { when: (candidate) => candidate.app === true },
    ),
  ];

  const enabled = specs.filter((spec) => spec.when === undefined || spec.when(options));
  const tree = yield* makeDoctorTree(enabled.map((spec) => spec.id));
  return yield* Effect.gen(function* () {
    yield* tree.start;
    let provider: DoctorProvider | undefined;
    for (const spec of enabled) {
      const sectionSkips = skipped.filter((entry) => entry.section === spec.id && entry.check === undefined);
      yield* tree.startTask(spec.id);
      if (sectionSkips.length > 0) {
        for (const skip of sectionSkips) {
          yield* tree.infoTask(spec.id, `${spec.id} · skipped · ${skip.reason}`);
        }
        continue;
      }
      const output = yield* runDoctorSection(spec, { budgetMs, redact });
      if (spec.id === "provider") provider = output.provider;
      checks.push(...output.checks);
      skipped.push(...output.skipped);
      yield* settleDoctorSection(tree, spec.id, sectionOutcomeFor(spec.id, output));
    }
    const report = makeDoctorReport({ provider, checks, skipped });
    yield* tree.close(doctorTreeSummary(report.summary));
    return report;
  }).pipe(Effect.onInterrupt(() => tree.settleInterrupt("doctor · interrupted")));
});

const sectionOutcomeFor = (id: DoctorSectionId, output: DoctorSectionOutput): DoctorSectionOutcome => {
  if (output.checks.length === 0 && output.skipped.length > 0)
    return { summary: `${id} · skipped`, skipped: true };
  return checksOutcome(id, output.checks);
};

/**
 * Build the combined report against an already-provided runtime.
 *
 * The error channel is `never` by construction: a section that fails, dies, or
 * overruns its deadline degrades to a fallback and contributes a self finding,
 * so `lando doctor` always answers with a structured report. Only a user
 * interrupt stops the run.
 */
export const doctorReport = Effect.fn("Doctor.report")(
  (
    options: DoctorOptions = {},
  ): Effect.Effect<
    DoctorReport,
    never,
    ConfigService | PathsService | RuntimeProviderRegistry | PluginRegistry
  > =>
    Effect.gen(function* () {
      const router = yield* Effect.serviceOption(RouterService);
      const ssh = yield* Effect.serviceOption(SshService);
      const resolver = yield* Effect.serviceOption(HostDnsResolver);
      const hasRuntimeSubsystems = Option.isSome(router) || Option.isSome(ssh);
      return yield* collectDoctorReport<
        ConfigService | PathsService | RuntimeProviderRegistry | PluginRegistry
      >({
        options,
        provider: doctor(options),
        listeners: listenerDoctorChecks,
        deprecations: doctorDeprecations(),
        appConfig: appConfigForReport(),
        ...(hasRuntimeSubsystems || Option.isSome(resolver)
          ? {
              subsystems: (subsystemOptions: SubsystemDoctorOptions) =>
                subsystemDoctor(subsystemOptions).pipe(
                  Effect.provide(
                    Option.isSome(resolver)
                      ? Layer.succeed(HostDnsResolver, resolver.value)
                      : HostDnsResolver.layer,
                  ),
                ),
            }
          : {}),
      });
    }),
);
