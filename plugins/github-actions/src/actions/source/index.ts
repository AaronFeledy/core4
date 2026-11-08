export { ActionSourceError } from "./errors.ts";
export {
  sourceCapabilities,
  sourceCacheIdentity,
  sourceLimits,
  verifyFixtureSource,
} from "./fixture.ts";
export type { FixtureFile, SourceReceipt, TrustedSourceManifest, VerifiedActionSource } from "./fixture.ts";
export { loadActionMetadata } from "./metadata.ts";
export { parseActionReference, resolveFixtureReference } from "./reference.ts";
export type {
  ActionReference,
  ActionSourcePolicy,
  DockerActionReference,
  LocalActionReference,
  RepositoryActionReference,
  ResolvedRepositoryReference,
  TrustedFixtureResolution,
} from "./reference.ts";
export { cacheVerifiedSource, loadCachedSource } from "./cache.ts";
