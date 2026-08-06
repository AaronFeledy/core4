import {
  type ResolveLandofileIncludesOptions,
  type UpdateLandofileIncludesOptions,
  type VerifyLandofileIncludesOptions,
  resolveLandofileIncludes as resolveLandofileIncludesPackage,
  updateLandofileIncludes as updateLandofileIncludesPackage,
  verifyLandofileIncludes as verifyLandofileIncludesPackage,
} from "@lando/landofile/includes";
import type { LintLandofileOptions } from "@lando/landofile/lint";
import { lintLandofile as lintLandofilePackage } from "@lando/landofile/lint";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import {
  findDiscoveredLandofilePath,
  loadLandofileFile as loadLandofileFilePackage,
  loadLandofileLayers as loadLandofileLayersPackage,
  makeLandofileServiceLive,
} from "@lando/landofile/service";
import {
  type RenderLandofileTemplateOptions,
  buildTemplateEngineRegistry,
  renderLandofileTemplate as renderLandofileTemplatePackage,
} from "@lando/landofile/template-render";
import { resolveUserCacheRoot } from "../cache/paths.ts";
import { BUNDLED_PLUGIN_MODULES } from "../plugins/generated/bundled.ts";
import { defaultGitRecipeCloner, publish } from "../recipes/git-source.ts";
import { makeNpmRecipeSourcePort } from "../recipes/npm-source.ts";
import { defaultTarballRecipeExtractor, defaultTarballRecipeFetcher } from "../recipes/tarball-source.ts";

const landofileRuntimeInputs: LandofileRuntimeInputs = {
  ports: {
    resolveUserCacheRoot,
    npmRecipeSource: makeNpmRecipeSourcePort(),
    git: defaultGitRecipeCloner,
    tarball: {
      fetch: defaultTarballRecipeFetcher.fetch,
      extract: defaultTarballRecipeExtractor.extract,
    },
    publication: { publish: (stagingDir, publishedDir) => publish(stagingDir, publishedDir) },
  },
  templates: { modules: BUNDLED_PLUGIN_MODULES },
};

export const bundledTemplateEngineRegistry = buildTemplateEngineRegistry(BUNDLED_PLUGIN_MODULES);

export const renderLandofileTemplate = (options: RenderLandofileTemplateOptions) =>
  renderLandofileTemplatePackage({ ...options, registry: options.registry ?? bundledTemplateEngineRegistry });

export const lintLandofile = (options: LintLandofileOptions = {}) =>
  lintLandofilePackage({ ...options, templates: options.templates ?? landofileRuntimeInputs.templates });

export const resolveLandofileIncludes = (options: ResolveLandofileIncludesOptions) =>
  resolveLandofileIncludesPackage({ ...options, ports: options.ports ?? landofileRuntimeInputs.ports });

export const updateLandofileIncludes = (options: UpdateLandofileIncludesOptions) =>
  updateLandofileIncludesPackage({ ...options, ports: options.ports ?? landofileRuntimeInputs.ports });

export const verifyLandofileIncludes = (options: VerifyLandofileIncludesOptions) =>
  verifyLandofileIncludesPackage({ ...options, ports: options.ports ?? landofileRuntimeInputs.ports });

export { findDiscoveredLandofilePath };

export const loadLandofileFile = (
  filePath: string,
  context?: Parameters<typeof loadLandofileFilePackage>[1],
) => loadLandofileFilePackage(filePath, context, landofileRuntimeInputs);

export const loadLandofileLayers = (appRoot: string, canonicalPath: string) =>
  loadLandofileLayersPackage(appRoot, canonicalPath, landofileRuntimeInputs);

export const LandofileServiceLive = makeLandofileServiceLive(landofileRuntimeInputs);
