import { sha256Hex } from "@lando/sdk/digest";
import type { ValueWithOrigins } from "@lando/sdk/landofile";
import { Effect, Predicate } from "effect";
import { rejectComposeKeys } from "./compose/rejections.ts";
import { composeIncludeDefaults } from "./include-compose-defaults.ts";
import type { FragmentResult, ResolveContext } from "./include-context.ts";
import { includeError, realpathOrSelf } from "./include-guard.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { parseLandofile } from "./parser.ts";
import { prepareOverlay } from "./pipeline/prepare.ts";
import {
  type AuthoredDocument,
  type AuthoredOrigin,
  type SourceDocument,
  emptyProvenance,
  normalizeReferencedFiles,
} from "./provenance.ts";
import type { VersionConstraintEntry } from "./version-constraint.ts";

export const parseFragment = Effect.fnUntraced(function* (
  fragment: FragmentResult & { readonly kind: "landofile" | "compose" | "tooling" },
  ctx: ResolveContext,
  layer: VersionConstraintEntry["layer"],
) {
  const parsed = yield* parseLandofile({
    file: fragment.filePath,
    content: fragment.content,
    cwd: fragment.root,
  });
  const composeCheck = rejectComposeKeys(fragment.authoredSource, parsed);
  if (ctx.recorder === undefined) yield* composeCheck;
  else ctx.recorder.effectiveChecks.push(composeCheck);
  const documents: readonly SourceDocument[] = Predicate.isObjectOrArray(parsed)
    ? [
        {
          file: fragment.filePath,
          form: "yaml",
          layer,
          document: parsed,
          content: fragment.content,
          digest: sha256Hex(fragment.content),
        },
      ]
    : [];
  const resolved = yield* resolveLandofileLoadExpressions({
    value: parsed,
    source: {
      appRoot: ctx.appRoot,
      sourcePath: fragment.filePath,
      sourceRoot: fragment.root,
      layer,
    },
    policy: fragment.userOwned ? { ...ctx.loadPolicy, allowFileAccess: false } : ctx.loadPolicy,
    pendingSites: ctx.pendingSites,
    recorder: ctx.recorder,
    environmentRecorder: ctx.loadScope?.environmentRecorder,
    ...(fragment.kind === "compose" ? { defaultServiceType: "compose" } : {}),
  });
  const onRelaxedRead = ctx.onRelaxedRead;
  if (onRelaxedRead !== undefined)
    yield* Effect.forEach(resolved.relaxedReads, (read) =>
      onRelaxedRead({
        sourcePath: fragment.filePath,
        authoredPath: read.authoredPath,
        absolutePath: read.absolutePath,
        appRoot: ctx.appRoot,
      }),
    ).pipe(Effect.asVoid);
  const value = resolved.value;
  if (!Predicate.isObject(value))
    return yield* Effect.fail(
      includeError({
        message: `Include ${fragment.sourceId} did not parse to a Landofile object.`,
        source: fragment.sourceId,
        kind: "parse-failed",
      }),
    );
  if (Object.hasOwn(value, "name") || Object.hasOwn(value, "runtime") || Object.hasOwn(value, "recipe"))
    return yield* Effect.fail(
      includeError({
        message: `Include ${fragment.sourceId} must not declare top-level name:, runtime:, or recipe:.`,
        source: fragment.sourceId,
        kind: "forbidden-field",
        remediation:
          "Remove top-level name:, runtime:, and recipe: from the fragment; the including Landofile owns the app's identity and recipe options.",
      }),
    );
  // Remote snapshots live in a shared cache, not the app's bindable source tree.
  // Canonicalize both roots so Windows 8.3 / symlink aliases still rebase to portable paths.
  const composeRoots =
    fragment.kind === "compose" && fragment.remoteOrigin === undefined && !fragment.userOwned
      ? {
          appRoot: yield* Effect.promise(() => realpathOrSelf(ctx.appRoot)),
          sourceRoot: yield* Effect.promise(() => realpathOrSelf(fragment.root)),
        }
      : undefined;
  const document = fragment.kind === "compose" ? composeIncludeDefaults(value, composeRoots) : value;
  const prepared = yield* prepareOverlay(document, { file: fragment.filePath, layer }, parsed);
  return {
    value: prepared.value,
    provenance: {
      ...emptyProvenance(prepared.origins),
      documents,
      referencedFiles: normalizeReferencedFiles(resolved.dependencies),
    },
  } satisfies AuthoredDocument;
});

export const withoutIncludeArrays = (landofile: AuthoredDocument): ValueWithOrigins<AuthoredOrigin> => {
  const { include: _include, includes: _includes, ...rest } = landofile.value;
  return { value: rest, origins: landofile.provenance.origins };
};

/**
 * The document's own `lando:` constraint, or the entries a resolved tree already
 * recorded.
 */
export const ownVersionConstraintEntries = (
  document: AuthoredDocument,
  source: string,
  layer: VersionConstraintEntry["layer"],
  order: VersionConstraintEntry["order"],
): ReadonlyArray<VersionConstraintEntry> => {
  if (document.provenance.versionConstraints.length > 0) return document.provenance.versionConstraints;
  const range = document.value.lando;
  return typeof range !== "string" ? [] : [{ range, source, layer, order }];
};
