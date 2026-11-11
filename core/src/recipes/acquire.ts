import { mapFailures } from "@lando/sdk/command-result";
import { RecipeManifestValidationError, RecipeSourceError } from "@lando/sdk/errors";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { parseValidationIssuePath, validationIssue } from "@lando/sdk/schema";
import { type SourceSession, displaySource } from "@lando/source-acquisition";
import { Cause, Effect, Exit } from "effect";
import type { InitAppOptions } from "../cli/commands/init";
import { parseInitSourceFlags } from "../cli/commands/init-source";
import type { InteractionPrompter } from "../interaction/prompter";
import { resolveGitRecipeSource } from "./git-source";
import type { FlattenRecipeContext } from "./manifest/flatten";
import { resolveNpmRecipeSource } from "./npm-source";
import { resolveRegistryRecipeSource } from "./registry-source";
import { resolveRecipeSource } from "./resolved-source";
import { type ResolvedRecipe, resolveRecipeRef } from "./source";
import { resolveTarballRecipeSource } from "./tarball-source";

const unwrap = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "Some") throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
};

export const parseResolvedRecipe = async (
  resolved: ResolvedRecipe,
  context: Partial<FlattenRecipeContext> = {},
) => {
  const resolution = await unwrap(resolveRecipeSource(resolved, context));
  const { files: _files, ...questionnaireSource } = resolution.source;
  const origin = resolution.sources.at(-1)?.origin;
  const questionnaire = await unwrap(
    Effect.fromResult(
      compileRecipeSource(questionnaireSource, {
        sourceKind: origin?.kind === "bundled" ? "bundled" : "local",
        packageName:
          origin?.kind === "bundled"
            ? `@lando/recipe-${questionnaireSource.id}`
            : (questionnaireSource.package ?? "local"),
        assets: [],
        configLayers: resolution.configLayers,
      }),
    ).pipe(
      mapFailures(
        (error) =>
          new RecipeManifestValidationError({
            source: resolution.source.id,
            message: error.message,
            issues: [validationIssue(parseValidationIssuePath(error.path ?? "config") ?? [], error.message)],
            remediation: error.remediation,
          }),
      ),
    ),
  );
  return { resolved, resolution, questionnaire };
};

export const acquireInitRecipe = async (
  options: InitAppOptions,
  recipeRef: string,
  interaction: InteractionPrompter | undefined,
) => {
  const sources = options.sources;
  const requireSources = (): SourceSession => {
    if (sources === undefined) {
      throw new RecipeSourceError({
        message: "Remote recipe acquisition requires a SourceSession spanning the init lifecycle.",
        source: displaySource(recipeRef),
        kind: "cache",
        remediation: "Open a source session before preparing a remote recipe.",
      });
    }
    return sources;
  };

  const flags = parseInitSourceFlags(options);
  const onWarn = options.onWarn ?? options.postInitIO?.err;
  const parse = (resolved: ResolvedRecipe) =>
    parseResolvedRecipe(resolved, {
      ...(sources === undefined ? {} : { sources }),
      ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
      ...(onWarn === undefined ? {} : { onWarn }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const path = flags.path === undefined ? {} : { path: flags.path };
  switch (flags.source) {
    case "git": {
      const ref = options.ref ?? flags.ref;
      return parse(
        await resolveGitRecipeSource({
          url: flags.url ?? "",
          sources: requireSources(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...path,
          ...(ref === undefined ? {} : { ref }),
          ...(onWarn === undefined ? {} : { onWarn }),
        }),
      );
    }
    case "tarball": {
      const confirmUnverified =
        options.nonInteractive !== true && options.yes !== true && interaction !== undefined
          ? (sha256: string) =>
              interaction.confirm({
                message: `No --checksum supplied for this tarball recipe; downloaded SHA-256 is ${sha256}. Continue without checksum verification?`,
                name: "checksum",
                default: false,
                mode: "interactive",
              })
          : undefined;
      return parse(
        await resolveTarballRecipeSource({
          url: flags.url ?? "",
          sources: requireSources(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...path,
          ...(flags.checksum === undefined ? {} : { checksum: flags.checksum }),
          ...(confirmUnverified === undefined ? {} : { confirmUnverified }),
          ...(onWarn === undefined ? {} : { onWarn }),
        }),
      );
    }
    case "npm":
      return parse(
        await resolveNpmRecipeSource({
          package: flags.package ?? "",
          sources: requireSources(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...path,
        }),
      );
    case "registry":
      return parse(
        await resolveRegistryRecipeSource({
          id: flags.id ?? "",
          sources: requireSources(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...path,
          ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
          ...(options.registryClient === undefined ? {} : { registryClient: options.registryClient }),
          ...(onWarn === undefined ? {} : { onWarn }),
        }),
      );
    case undefined:
      return parse(await unwrap(resolveRecipeRef(recipeRef, { cwd: options.cwd })));
    default:
      return flags.source satisfies never;
  }
};
