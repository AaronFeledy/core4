import { join } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { DeprecationSeverity, DeprecationSurfaceKind, MAILHOG_DEPRECATION_NOTICE } from "@lando/sdk/schema";
import { DeprecationService, FileSystem } from "@lando/sdk/services";
import { DateTime, Effect, Option, Schema } from "effect";
import type { DoctorFinding } from "./doctor-contract";

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
