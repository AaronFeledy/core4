import { dirname } from "node:path";

import { LandofileLoadFailure } from "@lando/sdk/errors";
import { Effect, Result, Schema } from "effect";
import { loadPathBlocked } from "./load-failures.ts";

import {
  type ValueOrigins,
  isMergeDirective,
  mergeLandofiles,
  override,
  valueOriginAt,
} from "@lando/sdk/landofile";

import { hasIncludeCycle } from "./include-graph.ts";
import { attributeIncludeError, includeError, realpathOrSelf } from "./include-guard.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";
import { type ToolingIncludeDefaults, layerIncludeDefaults } from "./tooling-include-defaults.ts";
import {
  type NormalizedToolingInclude,
  assertCompatibleIncludeFields,
  assertNamespacing,
  normalizeToolingIncludes,
} from "./tooling-include-entries.ts";
import {
  type ToolingIncludeError,
  type ToolingSourceContext,
  loadFragment,
  locateFragment,
} from "./tooling-source.ts";

interface Contribution {
  readonly defaults: ReadonlyMap<string, ToolingIncludeDefaults>;
  readonly sources: readonly SourceDocument[];
  readonly origins: ReadonlyMap<string, ValueOrigins<AuthoredOrigin>>;
  readonly tasks: ReadonlyMap<string, unknown>;
  readonly internal: ReadonlySet<string>;
  readonly paths: ReadonlyArray<string>;
  readonly referencedFiles: ReadonlyArray<LandofileReferencedFile>;
}

const COLLISION_REMEDIATION =
  "Give the colliding tooling includes distinct namespaces or aliases, or exclude the duplicated task.";
const CYCLE_REMEDIATION = "Break the tooling include cycle so no fragment transitively includes itself.";

const taskIds = (entry: NormalizedToolingInclude, name: string): ReadonlyArray<string> =>
  entry.flatten ? [name] : [entry.namespace ?? "", ...entry.aliases].map((prefix) => `${prefix}:${name}`);

interface ResolveContext extends ToolingSourceContext {
  readonly sourceRoot: string;
  readonly maxDepth: number;
}

export const resolveEntries = Effect.fnUntraced(function* (
  entries: ReadonlyArray<NormalizedToolingInclude>,
  ctx: ResolveContext,
  traversal: { readonly depth: number; readonly stack: ReadonlyArray<string> },
): Effect.fn.Return<Contribution, ToolingIncludeError> {
  const { depth, stack } = traversal;
  const tasks = new Map<string, unknown>();
  const internal = new Set<string>();
  const paths: string[] = [];
  const referencedFiles: LandofileReferencedFile[] = [];
  const sources: SourceDocument[] = [];
  const origins = new Map<string, ValueOrigins<AuthoredOrigin>>();
  const defaults = new Map<string, ToolingIncludeDefaults>();
  if (entries.length === 0) return { tasks, internal, paths, referencedFiles, sources, origins, defaults };

  for (const entry of entries) {
    if (entry.origin !== undefined && loadPathBlocked(ctx.recorder, entry.origin)) continue;
    const localTasks = new Map<string, unknown>();
    const localDefaults = new Map<string, ToolingIncludeDefaults>();
    const localOrigins = new Map<string, ValueOrigins<AuthoredOrigin>>();
    const localInternal = new Set<string>();
    const initialFailures = ctx.recorder?.failures.length ?? 0;
    const result = yield* Effect.gen(function* () {
      if (depth > ctx.maxDepth)
        return yield* Effect.fail(
          includeError({
            message: `Tooling includes exceed the maximum depth of ${ctx.maxDepth}.`,
            source: entry.source,
            kind: "max-depth",
            remediation: "Flatten the tooling include chain so it nests no deeper than the supported limit.",
          }),
        );
      const namespaceFailure = assertNamespacing(entry);
      if (namespaceFailure !== undefined) return yield* Effect.fail(namespaceFailure);

      const filePath = yield* locateFragment(entry, ctx.appRoot, ctx.sourceRoot);
      if (filePath === undefined) return;
      const identity = yield* Effect.promise(() => realpathOrSelf(filePath));
      if (hasIncludeCycle(stack, identity)) {
        return yield* Effect.fail(
          includeError({
            message: `Tooling include cycle detected at ${entry.source}.`,
            source: entry.source,
            kind: "cycle",
            remediation: CYCLE_REMEDIATION,
          }),
        );
      }

      const layer = entry.origin?.layer ?? ctx.layer ?? "canonical";
      const fragment = yield* loadFragment(entry, filePath, { ...ctx, layer });
      const incompatible = assertCompatibleIncludeFields(fragment.nested);
      if (incompatible !== undefined)
        return yield* Effect.fail(
          attributeIncludeError(
            incompatible,
            valueOriginAt(fragment.origins, incompatible.path ?? []).source,
          ),
        );
      const nested = yield* resolveEntries(
        normalizeToolingIncludes(fragment.nested, fragment.origins),
        { ...ctx, sourceRoot: dirname(filePath), layer },
        { depth: depth + 1, stack: [...stack, identity] },
      );
      sources.push(...nested.sources, ...fragment.sources);
      if ((ctx.recorder?.failures.length ?? 0) > initialFailures) return;

      const excluded = new Set(entry.excludes);
      const overlay = isMergeDirective(fragment.tooling)
        ? fragment.tooling
        : Object.fromEntries(
            Object.entries(fragment.tooling ?? {}).map(([name, task]) => [
              name,
              isMergeDirective(task) ? task : override(task),
            ]),
          );
      const local = mergeLandofiles([{ tooling: Object.fromEntries(nested.tasks) }, { tooling: overlay }]);
      const localNames = mergeLandofiles([{ tooling: overlay }]).tooling ?? {};
      const contributed = new Map<string, unknown>(Object.entries(local.tooling ?? {}));
      for (const name of excluded) contributed.delete(name);

      for (const [name, task] of contributed) {
        for (const id of taskIds(entry, name)) {
          if (tasks.has(id)) {
            return yield* Effect.fail(
              includeError({
                message: `Tooling includes both contribute task "${id}".`,
                source: entry.source,
                kind: "forbidden-field",
                remediation: COLLISION_REMEDIATION,
              }),
            );
          }
          localTasks.set(id, task);
          const taskOrigins =
            fragment.origins.children.get("tooling")?.children.get(name) ??
            nested.origins.get(name) ??
            fragment.origins;
          localDefaults.set(
            id,
            layerIncludeDefaults(
              { vars: entry.vars, varOrigins: entry.varOrigins },
              Object.hasOwn(localNames, name) ? undefined : nested.defaults.get(name),
            ),
          );
          const { replaced: _replaced, ...contributedOrigin } = taskOrigins;
          localOrigins.set(id, contributedOrigin);
          if (entry.internal || (!Object.hasOwn(localNames, name) && nested.internal.has(name))) {
            localInternal.add(id);
          }
        }
      }
      paths.push(filePath, ...nested.paths);
      referencedFiles.push(...fragment.referencedFiles, ...nested.referencedFiles);
    }).pipe(
      Effect.mapError((error) => attributeIncludeError(error, entry.origin)),
      Effect.result,
    );
    if (Result.isFailure(result)) {
      if (ctx.recorder === undefined || !Schema.is(LandofileLoadFailure)(result.failure))
        return yield* Effect.fail(result.failure);
      ctx.recorder.record(result.failure);
      continue;
    }
    for (const [id, task] of localTasks) tasks.set(id, task);
    for (const [id, value] of localDefaults) defaults.set(id, value);
    for (const [id, value] of localOrigins) origins.set(id, value);
    for (const id of localInternal) internal.add(id);
  }

  return { tasks, internal, paths, referencedFiles, sources, origins, defaults };
});
