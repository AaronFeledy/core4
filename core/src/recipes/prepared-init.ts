import { lstat } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { LANDOFILE_NAME, LANDOFILE_TS_NAME } from "@lando/landofile/discovery";
import { eligibleBindingPath } from "@lando/landofile/secret-reference";
import {
  optionValueMatchesDescriptor,
  validateOptionValues,
  validateRecipeSecretPrompts,
} from "@lando/sdk/recipes";
import { AbsolutePath, parseValidationIssuePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { recipeAssetDigest } from "./builtin/snapshot-asset.ts";
import { makeCompiledRecipeDecomposer } from "./compiled-decomposer.ts";
import { encodeRecipeLandofile } from "./init-pipeline/encoding.ts";
import { blocked } from "./init-pipeline/errors.ts";
import { auxiliaryDestination, renderAuxiliaryScaffold } from "./init-pipeline/files.ts";
import { postInitSemanticIssues } from "./manifest/action-semantics.ts";
import { shouldRunPostInitAction } from "./post-init/authorization.ts";
import { resolveCreateTemplate } from "./post-init/create-template.ts";
import type {
  PreparedRecipeInit,
  RecipeInitPreparationRequest,
  RecipeInitPreview,
} from "./prepared-init-types.ts";
export type {
  PreparedRecipeInit,
  PreparedRecipeOutput,
  RecipeInitPreparationRequest,
  RecipeInitPreview,
} from "./prepared-init-types.ts";

/** Only metadata reads: missing roots and nested parents remain absent. */
const inspectPath = async (path: string): Promise<boolean> => {
  const parent = dirname(path);
  if (parent !== path) {
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RangeError("Unsafe output parent.");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await inspectPath(parent);
  }
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return false;
  }
};

export const prepareRecipeInit = Effect.fn("RecipeInit.prepare")(function* (
  request: RecipeInitPreparationRequest,
) {
  const { compiled } = request;
  const manifest = compiled.manifest;
  const snapshot = compiled.snapshot;
  const secrets = yield* Effect.fromResult(validateRecipeSecretPrompts(manifest)).pipe(
    Effect.mapError(() => blocked("secret-prompts")),
  );
  for (const { disposition } of secrets) {
    if (disposition.kind !== "secret-store") continue;
    const path = parseValidationIssuePath(disposition.field);
    if (
      path === undefined ||
      !eligibleBindingPath(path) ||
      path.some((segment) => segment === "__proto__" || segment === "prototype" || segment === "constructor")
    )
      return yield* Effect.fail(blocked("secret-prompts"));
  }
  if (
    compiled.files.some(({ value }) => value.when !== undefined || value.engine !== undefined) ||
    compiled.postInit.some(({ value }) => postInitSemanticIssues(value, manifest.prompts).length > 0)
  )
    return yield* Effect.fail(blocked("validate"));
  const staticFiles = yield* Effect.try({
    try: () => {
      const destinations = [
        LANDOFILE_NAME,
        LANDOFILE_TS_NAME,
        ...compiled.files.map(({ value }) => normalize(value.dest)),
      ];
      for (const [index, destination] of destinations.entries()) {
        auxiliaryDestination(request.appRoot, destination);
        if (
          destinations
            .slice(index + 1)
            .some(
              (other) =>
                other === destination ||
                other.startsWith(`${destination}${sep}`) ||
                destination.startsWith(`${other}${sep}`),
            )
        )
          throw new RangeError("Conflicting output destinations.");
      }
      return compiled.files.map(({ value, content }) => {
        const destination = normalize(value.dest);
        const mode = value.mode === undefined ? 0o644 : Number.parseInt(value.mode, 8);
        if (value.mode !== undefined && (!/^[0-7]{3,4}$/.test(value.mode) || mode > 0o777))
          throw new RangeError("Unsafe output mode.");
        return {
          destination,
          mode,
          content:
            value.template === true
              ? new TextEncoder().encode(renderAuxiliaryScaffold(content, request.appName))
              : content,
        };
      });
    },
    catch: () => blocked("validate"),
  });
  const supplied = Object.fromEntries(Object.entries(request.answers).filter(([name]) => name !== "name"));
  const missing = Object.entries(snapshot.optionTypes)
    .filter(
      ([name, descriptor]) =>
        !Object.hasOwn(supplied, name) &&
        !Object.hasOwn(snapshot.defaults, name) &&
        !optionValueMatchesDescriptor(descriptor, undefined),
    )
    .map(([name]) => name);
  for (const prompt of manifest.prompts ?? []) {
    if (prompt.type === "secret" && request.secretAnswers?.[prompt.name] === undefined)
      missing.push(prompt.name);
  }
  // Reject supplied bad/unknown options even when another answer is missing.
  const presentTypes = Object.fromEntries(
    Object.entries(snapshot.optionTypes).filter(([name]) => !missing.includes(name)),
  );
  const answers = yield* Effect.fromResult(
    validateOptionValues(presentTypes, snapshot.defaults, supplied),
  ).pipe(Effect.mapError(() => blocked("validate")));
  if (missing.length > 0) return { status: "requires-input", missing } as const;
  const encoded = yield* encodeRecipeLandofile({
    ...request,
    manifest,
    answers,
    decomposer: makeCompiledRecipeDecomposer(manifest, {
      source: manifest.id,
      appRoot: AbsolutePath.make(request.appRoot),
    }),
  });
  if (compiled.postInit.some(({ content }) => content !== undefined && encoded.containsSecret(content)))
    return yield* Effect.fail(blocked("validate"));
  const outputs = yield* Effect.try({
    try: () => {
      const candidates = [
        { destination: LANDOFILE_NAME, content: new TextEncoder().encode(encoded.text), mode: 0o644 },
        ...staticFiles,
      ];
      return Object.freeze(
        candidates.map((candidate) => {
          if (encoded.containsSecret(candidate.content)) throw new RangeError("Invalid output inventory.");
          const bytes = candidate.content.slice();
          return Object.freeze({
            destination: candidate.destination,
            mode: candidate.mode,
            digest: recipeAssetDigest(bytes),
            byteLength: bytes.byteLength,
            get content() {
              return bytes.slice();
            },
          });
        }),
      );
    },
    catch: () => blocked("validate"),
  });
  const existing = yield* Effect.tryPromise({
    try: async () => {
      const paths = [...new Set([...outputs.map(({ destination }) => destination), LANDOFILE_TS_NAME])];
      return (
        await Promise.all(
          paths.map(async (path) =>
            (await inspectPath(join(resolve(request.appRoot), path))) ? path : undefined,
          ),
        )
      ).filter((path): path is string => path !== undefined);
    },
    catch: () => blocked("validate"),
  });
  const conflicts = existing.filter((path) => path === LANDOFILE_NAME || path === LANDOFILE_TS_NAME);
  const skippedScaffold = existing.some((path) => path !== LANDOFILE_NAME && path !== LANDOFILE_TS_NAME)
    ? outputs.slice(1).map(({ destination }) => destination)
    : [];
  const actions = yield* Effect.try({
    try: () =>
      compiled.postInit.filter(({ value }, index) => {
        if (
          (skippedScaffold.length > 0 && value.type !== "message") ||
          !shouldRunPostInitAction(value, { recipeId: manifest.id, answers }, index)
        )
          return false;
        if (value.type === "bun" && value.verb === "create")
          resolveCreateTemplate(value.template, index, { recipeId: manifest.id, answers });
        return true;
      }),
    catch: () => blocked("validate"),
  });
  const authorized = outputs.filter(({ destination }) => !skippedScaffold.includes(destination));
  const preview: RecipeInitPreview = {
    landofile: encoded.redact(encoded.text),
    outputs: authorized.map(({ destination, mode, digest, byteLength }) => ({
      destination,
      mode,
      digest,
      bytes: byteLength,
    })),
    actions: compiled.postInit.map((entry, index) => ({
      index,
      type: entry.value.type,
      authorized: actions.includes(entry),
    })),
    conflicts,
    skippedScaffold,
  };
  return Object.freeze({
    ...request,
    ...(request.secretAnswers === undefined
      ? {}
      : { secretAnswers: Object.freeze({ ...request.secretAnswers }) }),
    answers: Object.freeze(answers),
    status: "ready",
    outputs: Object.freeze(authorized),
    actions: Object.freeze(actions),
    skippedScaffold,
    conflicts,
    diagnostics: encoded.diagnostics,
    preview,
    redact: encoded.redact,
  } satisfies PreparedRecipeInit);
});
