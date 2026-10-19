import { dirname } from "node:path";

import { Effect, Predicate } from "effect";

import { ToolingIncludeCycleError } from "@lando/sdk/errors";
import { isMergeDirective, mergeLandofiles, override } from "@lando/sdk/landofile";
import type { LandofileShape, ToolingVarLiteral } from "@lando/sdk/schema";

import type { LandofileLoadScope } from "./compile.ts";
import { hasIncludeCycle } from "./include-graph.ts";
import { includeError, realpathOrSelf } from "./include-guard.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import {
  type NormalizedToolingInclude,
  assertCompatibleIncludeFields,
  assertNamespacing,
  hasToolingIncludes,
  normalizeToolingIncludes,
} from "./tooling-include-entries.ts";
import {
  type ToolingIncludeError,
  type ToolingSourceContext,
  loadFragment,
  locateFragment,
} from "./tooling-source.ts";

export { hasToolingIncludes } from "./tooling-include-entries.ts";
export type { ToolingIncludeError } from "./tooling-source.ts";

export interface ResolveToolingIncludesOptions {
  readonly landofile: Pick<LandofileShape, "includes" | "toolingIncludes">;
  readonly loadScope: LandofileLoadScope;
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly maxDepth?: number;
  readonly loadPolicy?: LandofileLoadPolicy;
  readonly onRelaxedRead?: ToolingSourceContext["onRelaxedRead"];
}

export interface ToolingIncludeResolution {
  readonly tooling: Readonly<Record<string, unknown>>;
  readonly internalTaskIds: ReadonlyArray<string>;
  readonly localFragmentPaths: ReadonlyArray<string>;
  readonly referencedFiles: ReadonlyArray<LandofileReferencedFile>;
}

interface Contribution {
  readonly tasks: ReadonlyMap<string, unknown>;
  readonly internal: ReadonlySet<string>;
  readonly paths: ReadonlyArray<string>;
  readonly referencedFiles: ReadonlyArray<LandofileReferencedFile>;
}

const COLLISION_REMEDIATION =
  "Give the colliding tooling includes distinct namespaces or aliases, or exclude the duplicated task.";
const CYCLE_REMEDIATION = "Break the tooling include cycle so no fragment transitively includes itself.";

const withIncludeVars = (task: unknown, vars: Readonly<Record<string, ToolingVarLiteral>>): unknown => {
  if (Object.keys(vars).length === 0 || !Predicate.isObject(task)) return task;
  const taskVars = Predicate.isObject(task.vars) ? task.vars : {};
  return { ...task, vars: { ...vars, ...taskVars } };
};

const taskIds = (entry: NormalizedToolingInclude, name: string): ReadonlyArray<string> =>
  entry.flatten ? [name] : [entry.namespace ?? "", ...entry.aliases].map((prefix) => `${prefix}:${name}`);

interface ResolveContext extends ToolingSourceContext {
  readonly sourceRoot: string;
  readonly maxDepth: number;
}

const resolveEntries = Effect.fnUntraced(function* (
  entries: ReadonlyArray<NormalizedToolingInclude>,
  ctx: ResolveContext,
  depth: number,
  stack: ReadonlyArray<string>,
): Effect.fn.Return<Contribution, ToolingIncludeError> {
  const tasks = new Map<string, unknown>();
  const internal = new Set<string>();
  const paths: string[] = [];
  const referencedFiles: LandofileReferencedFile[] = [];
  if (entries.length === 0) return { tasks, internal, paths, referencedFiles };
  if (depth > ctx.maxDepth) {
    return yield* Effect.fail(
      includeError({
        message: `Tooling includes exceed the maximum depth of ${ctx.maxDepth}.`,
        source: entries[0]?.source ?? "toolingIncludes",
        kind: "max-depth",
        remediation: "Flatten the tooling include chain so it nests no deeper than the supported limit.",
      }),
    );
  }

  for (const entry of entries) {
    const namespaceFailure = assertNamespacing(entry);
    if (namespaceFailure !== undefined) return yield* Effect.fail(namespaceFailure);

    const filePath = yield* locateFragment(entry, ctx.appRoot, ctx.sourceRoot);
    if (filePath === undefined) continue;
    const identity = yield* Effect.promise(() => realpathOrSelf(filePath));
    if (hasIncludeCycle(stack, identity)) {
      return yield* Effect.fail(
        new ToolingIncludeCycleError({
          message: `Tooling include cycle detected at ${entry.source}.`,
          source: entry.source,
          remediation: CYCLE_REMEDIATION,
        }),
      );
    }

    const fragment = yield* loadFragment(entry, filePath, ctx);
    const nested = yield* resolveEntries(
      normalizeToolingIncludes(fragment.nested),
      { ...ctx, sourceRoot: dirname(filePath) },
      depth + 1,
      [...stack, identity],
    );
    paths.push(filePath, ...nested.paths);
    referencedFiles.push(...fragment.referencedFiles, ...nested.referencedFiles);

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
        tasks.set(id, withIncludeVars(task, entry.vars));
        if (entry.internal || (!Object.hasOwn(localNames, name) && nested.internal.has(name))) {
          internal.add(id);
        }
      }
    }
  }

  return { tasks, internal, paths, referencedFiles };
});

export const resolveToolingIncludes = (
  options: ResolveToolingIncludesOptions,
): Effect.Effect<ToolingIncludeResolution, ToolingIncludeError> => {
  const forbidden = assertCompatibleIncludeFields(options.landofile);
  if (forbidden !== undefined) return Effect.fail(forbidden);
  if (!hasToolingIncludes(options.landofile)) {
    return Effect.succeed({ tooling: {}, internalTaskIds: [], localFragmentPaths: [], referencedFiles: [] });
  }
  return resolveEntries(
    normalizeToolingIncludes(options.landofile),
    {
      appRoot: options.appRoot,
      sourceRoot: options.sourceRoot,
      maxDepth: options.maxDepth ?? 8,
      loadScope: options.loadScope,
      loadPolicy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
      onRelaxedRead: options.onRelaxedRead,
    },
    0,
    [],
  ).pipe(
    Effect.map((contribution) => ({
      tooling: Object.fromEntries(contribution.tasks),
      internalTaskIds: [...contribution.internal],
      localFragmentPaths: contribution.paths,
      referencedFiles: contribution.referencedFiles,
    })),
  );
};
