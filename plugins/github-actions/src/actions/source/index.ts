export { cacheVerifiedSource, loadCachedSource } from "./cache.ts";
export { ActionSourceError } from "./errors.ts";
export type { FixtureFile, SourceReceipt, TrustedSourceManifest, VerifiedActionSource } from "./fixture.ts";
export {
  sourceCacheIdentity,
  sourceCapabilities,
  sourceLimits,
  verifyFixtureSource,
} from "./fixture.ts";
export { loadActionMetadata } from "./metadata.ts";
export type {
  ActionReference,
  ActionSourcePolicy,
  DockerActionReference,
  LocalActionReference,
  RepositoryActionReference,
  ResolvedRepositoryReference,
  TrustedFixtureResolution,
} from "./reference.ts";
export { parseActionReference, resolveFixtureReference } from "./reference.ts";
