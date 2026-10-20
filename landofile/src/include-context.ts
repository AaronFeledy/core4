import type {
  ComposeKeyRejectedError,
  LandofileIncludeError,
  LandofileLockMismatchError,
  LandofileParseError,
  LandofileValidationError,
  NotImplementedError,
  ToolingIncludeCycleError,
} from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import type { LandofileLoadScope } from "./compile.ts";
import { includeError } from "./include-guard.ts";
import type { LandofileLoadPolicy } from "./load-expression-file.ts";
import type { ResolveLandofileLoadExpressionError } from "./load-expression.ts";
import type {
  GitAcquisitionPort,
  LandofileRuntimePorts,
  NpmRecipeSourcePort,
  PublicationPort,
  TarballAcquisitionPort,
} from "./ports.ts";
import type { VersionConstraintEntry } from "./version-constraint.ts";

export type GitIncludeCloner = GitAcquisitionPort;
export type NpmIncludeRecipeSource = NpmRecipeSourcePort;
export type NpmIncludeFetcher = Pick<TarballAcquisitionPort, "fetch">;
export type NpmIncludeExtractor = Pick<TarballAcquisitionPort, "extract">;
export interface LandofileIncludeDeps {
  readonly gitCloner?: GitIncludeCloner;
  readonly npmRecipeSource?: NpmIncludeRecipeSource;
  readonly npmFetcher?: NpmIncludeFetcher;
  readonly npmExtractor?: NpmIncludeExtractor;
  readonly publication?: PublicationPort;
}
export interface LandofileRelaxedRead {
  readonly sourcePath: string;
  readonly authoredPath: string;
  readonly absolutePath: string;
  readonly appRoot: string;
}
export interface ResolveLandofileIncludesOptions {
  readonly loadScope: LandofileLoadScope;
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly sourcePath?: string;
  readonly cacheRoot?: string;
  readonly lockfilePath?: string;
  readonly now?: () => number;
  readonly deps?: LandofileIncludeDeps;
  readonly maxDepth?: number;
  readonly layer?: VersionConstraintEntry["layer"];
  readonly order?: VersionConstraintEntry["order"];
  readonly resolveTooling?: boolean;
  readonly loadPolicy?: LandofileLoadPolicy;
  readonly ports?: LandofileRuntimePorts;
  readonly stateStore?: StateStoreShape;
  readonly onRelaxedRead?: (read: LandofileRelaxedRead) => Effect.Effect<void>;
}
export interface NormalizedInclude {
  readonly source: string;
  readonly path?: string;
  readonly version?: string;
}
export interface LockEntry {
  readonly source: string;
  readonly version?: string;
  readonly resolved: string;
  readonly checksum: string;
}
export interface RemoteIncludeOrigin {
  readonly kind: "git" | "npm";
  readonly identity: string;
  readonly acquisitionSource: string;
  readonly resolved: string;
  readonly snapshotRoot: string;
  readonly cacheRoot: string;
}
export interface ResolveContext {
  readonly ancestors?: ReadonlyArray<string>;
  readonly remoteOrigin?: RemoteIncludeOrigin | undefined;
  readonly loadScope: LandofileLoadScope;
  readonly appRoot: string;
  readonly sourceRoot: string;
  readonly userOwned: boolean;
  readonly cacheRoot: string;
  readonly lockfilePath: string;
  readonly deps: LandofileIncludeDeps;
  readonly maxDepth: number;
  readonly mode: "pin" | "refresh" | "verify";
  readonly walk: {
    readonly selectors: Map<string, string | undefined>;
    readonly issues: Map<
      string,
      { readonly status: "missing" | "mismatch"; readonly expected: string | null; readonly actual: string }
    >;
    complete: boolean;
  };
  readonly lockEntries: ReadonlyMap<string, LockEntry>;
  readonly stagedLocks: Map<string, LockEntry>;
  readonly noNetwork: boolean;
  readonly loadPolicy: LandofileLoadPolicy;
  readonly ports?: LandofileRuntimePorts;
  readonly stateStore: StateStoreShape | undefined;
  readonly onRelaxedRead?: ResolveLandofileIncludesOptions["onRelaxedRead"];
}
export interface FragmentResult {
  readonly remoteOrigin?: RemoteIncludeOrigin;
  readonly sourceId: string;
  readonly inventoryId: string;
  readonly authoredSource: string;
  readonly resolved?: string;
  readonly version?: string;
  readonly content: string;
  readonly filePath: string;
  readonly root: string;
  readonly userOwned: boolean;
  readonly locked: boolean;
}
export const LOCK_REMEDIATION =
  "Run lando app:includes:update to refresh .lando.lock.yml after reviewing the include change.";
export const NO_NETWORK_REMEDIATION =
  "Run lando app:includes:update with network access to populate the include cache before retrying with --no-network.";
export const missingRuntimeInput = (input: string): LandofileIncludeError =>
  includeError({
    message: `Landofile include resolution requires an injected ${input}.`,
    source: "Landofile includes",
    kind: "source-unresolved",
    remediation: "Construct the Landofile runtime with the host-provided acquisition and cache ports.",
  });
export const requiredPorts = (ctx: ResolveContext): LandofileRuntimePorts => {
  if (ctx.ports !== undefined) return ctx.ports;
  throw missingRuntimeInput("runtime port set");
};
export const resolveCacheRoot = (
  cacheRoot: string | undefined,
  ports: LandofileRuntimePorts | undefined,
): Effect.Effect<string, LandofileIncludeError> => {
  if (cacheRoot !== undefined) return Effect.succeed(cacheRoot);
  if (ports !== undefined) return Effect.sync(ports.resolveUserCacheRoot);
  return Effect.fail(missingRuntimeInput("cache root"));
};
export type ResolveIncludesError =
  | ComposeKeyRejectedError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | LandofileParseError
  | LandofileValidationError
  | ResolveLandofileLoadExpressionError
  | NotImplementedError
  | ToolingIncludeCycleError;
