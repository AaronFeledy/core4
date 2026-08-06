import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { TemplateRenderContext } from "@lando/sdk/schema";

export interface GitAcquisitionPort {
  readonly clone: (input: {
    readonly url: string;
    readonly stagingDir: string;
    readonly dest: string;
  }) => Promise<{ readonly commitSha: string }>;
}

export interface NpmRecipePackageDist {
  readonly tarball: string;
  readonly integrity?: string;
  readonly shasum?: string;
}

export interface ResolvedNpmRecipePackage {
  readonly packageName: string;
  readonly version: string;
  readonly dist: NpmRecipePackageDist;
}

export interface NpmRecipeSourcePort {
  readonly resolve: (packageSpec: string) => Promise<ResolvedNpmRecipePackage>;
}

export interface TarballAcquisitionPort {
  readonly fetch: (url: string) => Promise<Uint8Array>;
  readonly extract: (archiveBytes: Uint8Array, destDir: string) => Promise<void>;
}

export interface PublicationPort {
  readonly publish: (stagingDir: string, publishedDir: string) => Promise<void>;
}

export interface LandofileRuntimePorts {
  readonly resolveUserCacheRoot: () => string;
  readonly npmRecipeSource: NpmRecipeSourcePort;
  readonly git: GitAcquisitionPort;
  readonly tarball: TarballAcquisitionPort;
  readonly publication: PublicationPort;
}

export interface TemplateEngineInputs {
  readonly modules: ReadonlyArray<LandoPluginModule>;
  readonly context?: TemplateRenderContext;
}

export interface LandofileRuntimeInputs {
  readonly ports: LandofileRuntimePorts;
  readonly templates: TemplateEngineInputs;
}
