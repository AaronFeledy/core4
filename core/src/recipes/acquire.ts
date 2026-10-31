import { RecipeManifestValidationError } from "@lando/sdk/errors";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { parseValidationIssuePath, validationIssue } from "@lando/sdk/schema";
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
      Effect.mapError(
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
  const flags = parseInitSourceFlags(options);
  const onWarn = options.onWarn ?? options.postInitIO?.err;
  const common = { ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }) };
  const parse = (resolved: ResolvedRecipe) =>
    parseResolvedRecipe(resolved, {
      ...common,
      ...(options.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: options.gitRecipeCloner }),
      ...(onWarn === undefined ? {} : { onWarn }),
    });
  const archive = {
    ...(options.tarballRecipeFetcher === undefined ? {} : { fetcher: options.tarballRecipeFetcher }),
    ...(options.tarballRecipeExtractor === undefined ? {} : { extractor: options.tarballRecipeExtractor }),
  };
  const path = flags.path === undefined ? {} : { path: flags.path };
  switch (flags.source) {
    case "git": {
      const ref = options.ref ?? flags.ref;
      return parse(
        await resolveGitRecipeSource({
          url: flags.url ?? "",
          ...common,
          ...path,
          ...(ref === undefined ? {} : { ref }),
          ...(onWarn === undefined ? {} : { onWarn }),
          ...(options.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: options.gitRecipeCloner }),
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
          ...common,
          ...archive,
          ...path,
          ...(flags.checksum === undefined ? {} : { checksum: flags.checksum }),
          ...(confirmUnverified === undefined
            ? onWarn === undefined
              ? {}
              : { onWarn }
            : { confirmUnverified }),
        }),
      );
    }
    case "npm":
      return parse(
        await resolveNpmRecipeSource({
          package: flags.package ?? "",
          ...common,
          ...archive,
          ...path,
          ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
          ...(options.npmRegistryClient === undefined ? {} : { registryClient: options.npmRegistryClient }),
        }),
      );
    case "registry":
      return parse(
        await resolveRegistryRecipeSource({
          id: flags.id ?? "",
          ...common,
          ...path,
          ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
          ...(options.registryClient === undefined ? {} : { registryClient: options.registryClient }),
          ...(options.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: options.gitRecipeCloner }),
          ...(options.tarballRecipeFetcher === undefined
            ? {}
            : { tarballRecipeFetcher: options.tarballRecipeFetcher }),
          ...(options.tarballRecipeExtractor === undefined
            ? {}
            : { tarballRecipeExtractor: options.tarballRecipeExtractor }),
        }),
      );
    case undefined:
      return parse(await unwrap(resolveRecipeRef(recipeRef, { cwd: options.cwd })));
    default:
      return flags.source satisfies never;
  }
};
