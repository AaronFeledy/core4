import { join } from "node:path";
import { LandofileIncludeError } from "@lando/sdk/errors";
import { type ValueOrigins, valueOriginAt } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { materializeIncludeConditions } from "./include-conditions.ts";
import { attributeIncludeError } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import type {
  AuthoredDocument,
  AuthoredOrigin,
  LandofileReferencedFile,
  SourceDocument,
} from "./provenance.ts";
import type { ToolingIncludeDefaults } from "./tooling-include-defaults.ts";
import {
  assertCompatibleIncludeFields,
  hasToolingIncludes,
  normalizeToolingIncludes,
} from "./tooling-include-entries.ts";
import { resolveEntries } from "./tooling-include-tree.ts";
import type { ToolingIncludeError, ToolingSourceContext } from "./tooling-source.ts";
import { validationErrorFromCause } from "./validation.ts";

export { hasToolingIncludes } from "./tooling-include-entries.ts";
export type { ToolingIncludeError } from "./tooling-source.ts";

export interface ResolveToolingIncludesOptions {
  readonly recorder?: LoadFailureRecorder | undefined;
  readonly document: AuthoredDocument;
  readonly loadScope: LandofileLoadScope;
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly maxDepth?: number;
  readonly loadPolicy?: LandofileLoadPolicy;
  readonly onRelaxedRead?: ToolingSourceContext["onRelaxedRead"];
}

export interface InternalToolingSource {
  readonly tooling: Readonly<Record<string, unknown>> | undefined;
  readonly internalTaskIds: ReadonlyArray<string>;
}

/** Highest-precedence membership wins: a later source that defines the task decides. */
export const winningInternalToolingTasks = (
  sources: ReadonlyArray<InternalToolingSource>,
): ReadonlyArray<string> => {
  const winners = new Set<string>();
  for (const source of sources) {
    const internal = new Set(source.internalTaskIds);
    for (const id of Object.keys(source.tooling ?? {})) {
      if (internal.has(id)) winners.add(id);
      else winners.delete(id);
    }
  }
  return [...winners];
};

export interface ResolvedTooling {
  readonly value: Record<string, unknown>;
  readonly origins: ValueOrigins<AuthoredOrigin>;
}

export interface ToolingIncludeResolution {
  readonly defaults: ReadonlyMap<string, ToolingIncludeDefaults>;
  readonly sources: readonly SourceDocument[];
  readonly tooling: ResolvedTooling;
  readonly internalTaskIds: ReadonlyArray<string>;
  readonly localFragmentPaths: ReadonlyArray<string>;
  readonly referencedFiles: ReadonlyArray<LandofileReferencedFile>;
}

export const resolveToolingIncludes = Effect.fnUntraced(function* (
  options: ResolveToolingIncludesOptions,
): Effect.fn.Return<ToolingIncludeResolution, ToolingIncludeError> {
  const file = options.document.provenance.origins.source.file ?? join(options.sourceRoot, ".lando.yml");
  const conditioned = yield* materializeIncludeConditions(options.document, {
    source: {
      sourcePath: file,
      sourceRoot: options.sourceRoot,
      appRoot: options.appRoot,
      layer: options.document.provenance.origins.source.layer,
    },
    policy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    scope: { ...options.loadScope, recorder: options.recorder ?? options.loadScope.recorder },
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  });
  const surface = yield* Effect.try({
    try: () => includeAcquisitionView(conditioned.value),
    catch: (cause) => validationErrorFromCause(file, conditioned.value, cause),
  });
  const origins = conditioned.provenance.origins;
  const toolingOrigin: ValueOrigins<AuthoredOrigin> = origins.children.get("tooling") ?? origins;
  const forbidden = assertCompatibleIncludeFields(surface);
  if (forbidden !== undefined) {
    const origin = valueOriginAt(origins, forbidden.path ?? []).source;
    return yield* Effect.fail(
      attributeIncludeError(
        // Copy fields explicitly: `message` is not an own enumerable property, so a spread drops it.
        new LandofileIncludeError({
          message: forbidden.message,
          source: forbidden.source,
          kind: forbidden.kind,
          remediation: forbidden.remediation,
          path: origin?.path ?? forbidden.path,
        }),
        origin,
      ),
    );
  }
  if (!hasToolingIncludes(surface))
    return {
      defaults: new Map(),
      tooling: { value: {}, origins: { ...toolingOrigin, children: new Map() } },
      internalTaskIds: [],
      localFragmentPaths: [],
      referencedFiles: [],
      sources: [],
    };
  const contribution = yield* resolveEntries(
    normalizeToolingIncludes(surface, origins),
    {
      appRoot: options.appRoot,
      recorder: options.recorder,
      sourceRoot: options.sourceRoot,
      maxDepth: options.maxDepth ?? 8,
      loadScope: { ...options.loadScope, recorder: options.recorder ?? options.loadScope.recorder },
      loadPolicy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
      onRelaxedRead: options.onRelaxedRead,
    },
    { depth: 0, stack: [] },
  );
  return {
    defaults: contribution.defaults,
    tooling: {
      value: Object.fromEntries(contribution.tasks),
      origins: { ...toolingOrigin, children: contribution.origins },
    },
    sources: contribution.sources,
    internalTaskIds: [...contribution.internal],
    localFragmentPaths: contribution.paths,
    referencedFiles: contribution.referencedFiles,
  };
});
