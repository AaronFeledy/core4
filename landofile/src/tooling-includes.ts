import { join } from "node:path";
import { LandofileIncludeError } from "@lando/sdk/errors";
import { type ValueOrigins, valueOriginAt } from "@lando/sdk/landofile";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import { materializeIncludeConditions } from "./include-conditions.ts";
import { attributeIncludeError } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, type LandofileLoadPolicy } from "./load-expression-file.ts";
import type { LandofileReferencedFile } from "./load-expression-provenance.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import { getOrigins, rememberOrigins } from "./pipeline/origins.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";
import type { SourceDocument } from "./pipeline/source-table.ts";
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
  readonly origins?: ValueOrigins<AuthoredOrigin> | undefined;
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

export const resolveToolingIncludes = Effect.fnUntraced(function* (
  options: ResolveToolingIncludesOptions,
): Effect.fn.Return<ToolingIncludeResolution, ToolingIncludeError> {
  const file = options.origins?.source.file ?? join(options.sourceRoot, ".lando.yml");
  const document = copyLandofileProvenance(options.landofile, { ...options.landofile });
  if (options.origins !== undefined) rememberOrigins(document, options.origins);
  const conditioned = yield* materializeIncludeConditions(document, {
    source: {
      sourcePath: file,
      sourceRoot: options.sourceRoot,
      appRoot: options.appRoot,
      layer: options.origins?.source.layer ?? "canonical",
    },
    policy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    scope: { ...options.loadScope, recorder: options.recorder ?? options.loadScope.recorder },
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  });
  const surface = yield* Effect.try({
    try: () => includeAcquisitionView(conditioned),
    catch: (cause) => validationErrorFromCause(file, conditioned, cause),
  });
  const origins = getOrigins(conditioned);
  const forbidden = assertCompatibleIncludeFields(surface);
  if (forbidden !== undefined) {
    const origin = origins === undefined ? undefined : valueOriginAt(origins, forbidden.path ?? []).source;
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
      tooling: {},
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
    tooling: rememberOrigins(Object.fromEntries(contribution.tasks), {
      source: { file: options.sourceRoot, layer: "canonical", path: ["tooling"] },
      deleted: false,
      children: contribution.origins,
    }),
    sources: contribution.sources,
    internalTaskIds: [...contribution.internal],
    localFragmentPaths: contribution.paths,
    referencedFiles: contribution.referencedFiles,
  };
});
