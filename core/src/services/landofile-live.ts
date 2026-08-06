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
import type { LandofileRuntimeInputs, NpmPackument } from "@lando/landofile/ports";
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
import { Schema } from "effect";

import { resolveUserCacheRoot } from "../cache/paths.ts";
import { httpJsonFetch } from "../http-client/json-fetch.ts";
import { BUNDLED_PLUGIN_MODULES } from "../plugins/generated/bundled.ts";
import { defaultGitRecipeCloner, publish } from "../recipes/git-source.ts";
import { DEFAULT_NPM_REGISTRY_URL } from "../recipes/npm-source.ts";
import { defaultTarballRecipeExtractor, defaultTarballRecipeFetcher } from "../recipes/tarball-source.ts";

const encodePackageName = (name: string): string =>
  name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

const NpmPackageDistSchema = Schema.Struct({
  tarball: Schema.String,
  integrity: Schema.optional(Schema.String),
  shasum: Schema.optional(Schema.String),
});

const NpmPackumentSchema = Schema.Struct({
  "dist-tags": Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  versions: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({ dist: NpmPackageDistSchema }),
    }),
  ),
});

const decodeNpmPackument = Schema.decodeUnknownSync(NpmPackumentSchema);

const landofileRuntimeInputs: LandofileRuntimeInputs = {
  ports: {
    resolveUserCacheRoot,
    httpMetadata: {
      fetchNpmPackument: async (packageName) => {
        const response = await httpJsonFetch(
          `${DEFAULT_NPM_REGISTRY_URL}/${encodePackageName(packageName)}`,
          {
            headers: [{ name: "accept", value: "application/json" }],
            redirect: "follow",
          },
        );
        if (response.status === 404) return undefined;
        if (response.status < 200 || response.status >= 300) throw new TypeError(`HTTP ${response.status}`);
        const packument: unknown = JSON.parse(new TextDecoder().decode(response.bytes));
        return decodeNpmPackument(packument) as NpmPackument;
      },
    },
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
