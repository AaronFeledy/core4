import { dirname } from "node:path";

import { LandofileIncludeError } from "@lando/sdk/errors";
import { Effect } from "effect";

import {
  type ValueOrigins,
  isMergeDirective,
  mergeLandofiles,
  override,
  valueOriginAt,
} from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";

import { hasIncludeCycle } from "./include-graph.ts";
import { attributeIncludeError, includeError, realpathOrSelf } from "./include-guard.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import { rememberOrigins } from "./pipeline/origins.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";
import { type ToolingIncludeDefaults, layerIncludeDefaults } from "./tooling-include-defaults.ts";
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
  readonly origins?: ValueOrigins<AuthoredOrigin>;
  readonly landofile: Pick<LandofileShape, "includes" | "toolingIncludes">;
  readonly loadScope: LandofileLoadScope;
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly maxDepth?: number;
  readonly loadPolicy?: LandofileLoadPolicy;
  readonly onRelaxedRead?: ToolingSourceContext["onRelaxedRead"];
}

export interface ToolingIncludeResolution {
  readonly defaults: ReadonlyMap<string, ToolingIncludeDefaults>;
  readonly sources: readonly SourceDocument[];
  readonly tooling: Readonly<Record<string, unknown>>;
  readonly internalTaskIds: ReadonlyArray<string>;
  readonly localFragmentPaths: ReadonlyArray<string>;
  readonly referencedFiles: ReadonlyArray<LandofileReferencedFile>;
}

interface Contribution {
  readonly defaults: ToolingIncludeResolution["defaults"];
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
  const sources: SourceDocument[] = [];
  const origins = new Map<string, ValueOrigins<AuthoredOrigin>>();
  const defaults = new Map<string, ToolingIncludeDefaults>();
  if (entries.length === 0) return { tasks, internal, paths, referencedFiles, sources, origins, defaults };
  if (depth > ctx.maxDepth) {
    return yield* Effect.fail(
      attributeIncludeError(
        includeError({
          message: `Tooling includes exceed the maximum depth of ${ctx.maxDepth}.`,
          source: entries[0]?.source ?? "toolingIncludes",
          kind: "max-depth",
          remediation: "Flatten the tooling include chain so it nests no deeper than the supported limit.",
        }),
        entries[0]?.origin,
      ),
    );
  }

  for (const entry of entries) {
    yield* Effect.gen(function* () {
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
        depth + 1,
        [...stack, identity],
      );
      paths.push(filePath, ...nested.paths);
      referencedFiles.push(...fragment.referencedFiles, ...nested.referencedFiles);
      sources.push(...nested.sources, ...fragment.sources);

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
          tasks.set(id, task);
          const taskOrigins =
            fragment.origins.children.get("tooling")?.children.get(name) ??
            nested.origins.get(name) ??
            fragment.origins;
          defaults.set(
            id,
            layerIncludeDefaults(
              { vars: entry.vars, varOrigins: entry.varOrigins },
              Object.hasOwn(localNames, name) ? undefined : nested.defaults.get(name),
            ),
          );
          const { replaced: _replaced, ...contributedOrigin } = taskOrigins;
          origins.set(id, contributedOrigin);
          if (entry.internal || (!Object.hasOwn(localNames, name) && nested.internal.has(name))) {
            internal.add(id);
          }
        }
      }
    }).pipe(Effect.mapError((error) => attributeIncludeError(error, entry.origin)));
  }

  return { tasks, internal, paths, referencedFiles, sources, origins, defaults };
});

export const resolveToolingIncludes = (
  options: ResolveToolingIncludesOptions,
): Effect.Effect<ToolingIncludeResolution, ToolingIncludeError> => {
  const forbidden = assertCompatibleIncludeFields(options.landofile);
  if (forbidden !== undefined) {
    const origin =
      options.origins === undefined ? undefined : valueOriginAt(options.origins, forbidden.path ?? []).source;
    return Effect.fail(
      attributeIncludeError(
        new LandofileIncludeError({ ...forbidden, path: origin?.path ?? forbidden.path }),
        origin,
      ),
    );
  }
  if (!hasToolingIncludes(options.landofile)) {
    return Effect.succeed({
      defaults: new Map(),
      tooling: {},
      internalTaskIds: [],
      localFragmentPaths: [],
      referencedFiles: [],
      sources: [],
    });
  }
  return resolveEntries(
    normalizeToolingIncludes(options.landofile, options.origins),
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
      defaults: contribution.defaults,
      tooling: rememberOrigins(Object.fromEntries(contribution.tasks), {
        source: { file: options.sourceRoot, layer: "canonical", path: ["tooling"] },
        deleted: false,
        children: contribution.origins,
      }),
      sources: contribution.sources,
      internalTaskIds: [...contribution.internal],
      localFragmentPaths: contribution.paths,
      referencedFiles: contribution.referencedFiles,
    })),
  );
};
