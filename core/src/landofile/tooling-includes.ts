import { dirname, isAbsolute, resolve } from "node:path";

import { Effect } from "effect";

import {
  type ComposeKeyRejectedError,
  LandofileIncludeError,
  type LandofileParseError,
  type NotImplementedError,
  ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import type { LandofileShape, ToolingVarLiteral } from "@lando/sdk/schema";

import { rejectComposeKeys, rejectComposeTags } from "./compose/rejections.ts";
import { assertUnderRoot, includeError, realpathOrSelf } from "./include-guard.ts";
import { parseLandofile } from "./parser.ts";
import { rejectBetaToolingFeatures } from "./tooling-beta.ts";
import { assertToolingFragment, isPlainRecord } from "./tooling-fragment.ts";
import {
  type NormalizedToolingInclude,
  assertCompatibleIncludeFields,
  assertNamespacing,
  hasToolingIncludes,
  normalizeToolingIncludes,
} from "./tooling-include-entries.ts";

export { hasToolingIncludes } from "./tooling-include-entries.ts";

export interface ResolveToolingIncludesOptions {
  readonly landofile: Pick<LandofileShape, "includes" | "toolingIncludes">;
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly maxDepth?: number;
}

export interface ToolingIncludeResolution {
  readonly tooling: Readonly<Record<string, unknown>>;
  readonly internalTaskIds: ReadonlyArray<string>;
  readonly localFragmentPaths: ReadonlyArray<string>;
}

export type ToolingIncludeError =
  | ComposeKeyRejectedError
  | LandofileIncludeError
  | LandofileParseError
  | NotImplementedError
  | ToolingIncludeCycleError;

interface Contribution {
  readonly tasks: ReadonlyMap<string, unknown>;
  readonly internal: ReadonlySet<string>;
  readonly paths: ReadonlyArray<string>;
}

interface Fragment {
  readonly filePath: string;
  readonly tooling: Readonly<Record<string, unknown>>;
  readonly nested: Pick<LandofileShape, "includes" | "toolingIncludes">;
}

const MISSING_REMEDIATION = "Create the tooling fragment, fix its path, or mark the include optional: true.";
const COLLISION_REMEDIATION =
  "Give the colliding tooling includes distinct namespaces or aliases, or exclude the duplicated task.";
const CYCLE_REMEDIATION = "Break the tooling include cycle so no fragment transitively includes itself.";

const withIncludeVars = (task: unknown, vars: Readonly<Record<string, ToolingVarLiteral>>): unknown => {
  if (Object.keys(vars).length === 0 || !isPlainRecord(task)) return task;
  const taskVars = isPlainRecord(task.vars) ? task.vars : {};
  return { ...task, vars: { ...vars, ...taskVars } };
};

const taskIds = (entry: NormalizedToolingInclude, name: string): ReadonlyArray<string> =>
  entry.flatten ? [name] : [entry.namespace ?? "", ...entry.aliases].map((prefix) => `${prefix}:${name}`);

const readFragmentText = (filePath: string, source: string): Effect.Effect<string, LandofileIncludeError> =>
  Effect.tryPromise({
    try: () => Bun.file(filePath).text(),
    catch: (cause) =>
      includeError({
        message: `Could not read tooling include ${source} at ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        source,
        kind: "fetch-failed",
      }),
  });

const locateFragment = (
  entry: NormalizedToolingInclude,
  appRoot: string,
  sourceRoot: string,
): Effect.Effect<string | undefined, LandofileIncludeError> =>
  Effect.tryPromise({
    try: async (): Promise<string | undefined> => {
      const candidate = isAbsolute(entry.source) ? entry.source : resolve(sourceRoot, entry.source);
      const contained = await assertUnderRoot(appRoot, candidate, entry.source);
      if (!(await Bun.file(contained).exists())) {
        if (entry.optional) return undefined;
        throw includeError({
          message: `Tooling include ${entry.source} was not found at ${candidate}.`,
          source: entry.source,
          kind: "fetch-failed",
          remediation: MISSING_REMEDIATION,
        });
      }
      return contained;
    },
    catch: (cause) =>
      cause instanceof LandofileIncludeError
        ? cause
        : includeError({
            message: cause instanceof Error ? cause.message : String(cause),
            source: entry.source,
            kind: "fetch-failed",
          }),
  });

const loadFragment = (
  entry: NormalizedToolingInclude,
  filePath: string,
): Effect.Effect<Fragment, ToolingIncludeError> =>
  readFragmentText(filePath, entry.source).pipe(
    Effect.flatMap((content) => rejectComposeTags(entry.source, content)),
    Effect.flatMap((content) => parseLandofile({ file: filePath, content, cwd: dirname(filePath) })),
    Effect.flatMap((parsed) => assertToolingFragment(parsed, entry.source, filePath)),
    Effect.flatMap((parsed) => rejectComposeKeys(entry.source, parsed).pipe(Effect.as(parsed))),
    Effect.tap((parsed) => rejectBetaToolingFeatures(filePath, parsed)),
    Effect.map((parsed) => ({
      filePath,
      tooling: isPlainRecord(parsed.tooling) ? parsed.tooling : {},
      nested: parsed as Pick<LandofileShape, "includes" | "toolingIncludes">,
    })),
  );

interface ResolveContext {
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly maxDepth: number;
}

const resolveEntries = (
  entries: ReadonlyArray<NormalizedToolingInclude>,
  ctx: ResolveContext,
  depth: number,
  stack: ReadonlyArray<string>,
): Effect.Effect<Contribution, ToolingIncludeError> =>
  Effect.gen(function* () {
    const tasks = new Map<string, unknown>();
    const internal = new Set<string>();
    const paths: string[] = [];
    if (entries.length === 0) return { tasks, internal, paths };
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
      if (stack.includes(identity)) {
        return yield* Effect.fail(
          new ToolingIncludeCycleError({
            message: `Tooling include cycle detected at ${entry.source}.`,
            source: entry.source,
            remediation: CYCLE_REMEDIATION,
          }),
        );
      }

      const fragment = yield* loadFragment(entry, filePath);
      const nested = yield* resolveEntries(
        normalizeToolingIncludes(fragment.nested),
        { ...ctx, sourceRoot: dirname(filePath) },
        depth + 1,
        [...stack, identity],
      );
      paths.push(filePath, ...nested.paths);

      const excluded = new Set(entry.excludes);
      const contributed = new Map<string, unknown>([...nested.tasks, ...Object.entries(fragment.tooling)]);
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
          if (entry.internal || (!Object.hasOwn(fragment.tooling, name) && nested.internal.has(name))) {
            internal.add(id);
          }
        }
      }
    }

    return { tasks, internal, paths };
  });

export const resolveToolingIncludes = (
  options: ResolveToolingIncludesOptions,
): Effect.Effect<ToolingIncludeResolution, ToolingIncludeError> => {
  const forbidden = assertCompatibleIncludeFields(options.landofile);
  if (forbidden !== undefined) return Effect.fail(forbidden);
  if (!hasToolingIncludes(options.landofile)) {
    return Effect.succeed({ tooling: {}, internalTaskIds: [], localFragmentPaths: [] });
  }
  return resolveEntries(
    normalizeToolingIncludes(options.landofile),
    { appRoot: options.appRoot, sourceRoot: options.sourceRoot, maxDepth: options.maxDepth ?? 8 },
    0,
    [],
  ).pipe(
    Effect.map((contribution) => ({
      tooling: Object.fromEntries(contribution.tasks),
      internalTaskIds: [...contribution.internal],
      localFragmentPaths: contribution.paths,
    })),
  );
};
