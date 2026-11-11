import type { StateStoreShape } from "@lando/sdk/services";
import type { Effect, Scope } from "effect";
import type { SourceAcquisitionError } from "./errors.ts";
import type { GcOptions, SourceGcReport } from "./gc-schema.ts";
import type { NpmPackageDist, NpmPackument } from "./npm.ts";

export type { NpmPackageDist, NpmPackument, NpmPackumentVersion } from "./npm.ts";

export type GitPin = { readonly kind: "git"; readonly url: string; readonly commit: string };
export type NpmPin = {
  readonly kind: "npm";
  readonly name: string;
  readonly version: string;
  readonly registry: string;
  readonly dist: NpmPackageDist;
};
export type ArchivePin = { readonly kind: "archive"; readonly url: string; readonly sha256: string };

export type SourcePin = GitPin | NpmPin | ArchivePin;

export type SourceKey =
  | { readonly kind: "git"; readonly commit: string }
  | { readonly kind: "archive"; readonly sha256: string };

export interface SourceSnapshot<P extends SourcePin = SourcePin> {
  readonly root: string;
  readonly key: SourceKey;
  readonly pin: P;
}

export interface GitTransport {
  readonly resolve?: (input: {
    readonly url: string;
    readonly ref?: string;
    readonly signal?: AbortSignal;
  }) => Promise<string | undefined>;
  readonly fetch: (input: {
    readonly url: string;
    readonly ref?: string;
    readonly dest: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly commit: string }>;
}

export interface ArchiveTransport {
  readonly fetch: (url: string, options?: { readonly signal?: AbortSignal }) => Promise<Uint8Array>;
}

export interface NpmRegistryTransport {
  readonly registryFor: (name: string) => string | Promise<string>;
  readonly packument: (
    name: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<NpmPackument | undefined>;
  readonly tarball: (input: {
    readonly packageName: string;
    readonly dist: NpmPackageDist;
    readonly signal?: AbortSignal;
  }) => Promise<Uint8Array>;
}

export interface SourceTransports {
  readonly git?: GitTransport;
  readonly archive?: ArchiveTransport;
  readonly npmRegistry?: NpmRegistryTransport;
}

export interface SourceStoreOptions {
  readonly stateStore: StateStoreShape;
  readonly transports: SourceTransports;
}
export interface AcquisitionOptions {
  readonly repair?: boolean;
}
export interface GitAcquisitionOptions extends AcquisitionOptions {
  readonly onStaleFallback?: (commit: string) => void | Promise<void>;
}
export interface ArchiveAcquisitionOptions extends AcquisitionOptions {
  readonly onUnverified?: (sha256: string) => void | Promise<void>;
}

export interface MaterializeOptions {
  readonly repair?: boolean;
  readonly network?: boolean;
}

export interface SourceSession {
  readonly openGit: (
    commit: string,
  ) => Effect.Effect<SourceSnapshot<GitPin> | undefined, SourceAcquisitionError>;
  readonly openArchive: (
    sha256: string,
  ) => Effect.Effect<SourceSnapshot<ArchivePin> | undefined, SourceAcquisitionError>;
  readonly acquireGit: (
    locator: { readonly url: string; readonly ref?: string },
    options?: GitAcquisitionOptions,
  ) => Effect.Effect<SourceSnapshot<GitPin>, SourceAcquisitionError>;
  readonly materializeGit: (
    pin: { readonly url: string; readonly commit: string },
    options?: MaterializeOptions,
  ) => Effect.Effect<SourceSnapshot<GitPin>, SourceAcquisitionError>;
  readonly registerRoot: (lockfile: string) => Effect.Effect<void, SourceAcquisitionError>;
  readonly resolveNpm: (locator: {
    readonly name: string;
    readonly selector?: string;
  }) => Effect.Effect<NpmPin, SourceAcquisitionError>;
  readonly materializeNpm: (
    pin: NpmPin,
    options?: MaterializeOptions,
  ) => Effect.Effect<SourceSnapshot<NpmPin>, SourceAcquisitionError>;
  readonly acquireNpm: (
    locator: { readonly name: string; readonly selector?: string },
    options?: AcquisitionOptions,
  ) => Effect.Effect<SourceSnapshot<NpmPin>, SourceAcquisitionError>;
  readonly lookupNpm: (input: {
    readonly name: string;
    readonly version: string;
    readonly registry?: string;
  }) => Effect.Effect<SourceSnapshot<NpmPin> | undefined, SourceAcquisitionError>;
  readonly materializeArchive: (
    pin: ArchivePin,
    options?: MaterializeOptions,
  ) => Effect.Effect<SourceSnapshot<ArchivePin>, SourceAcquisitionError>;
  readonly acquireArchive: (
    locator: { readonly url: string; readonly sha256?: string },
    options?: ArchiveAcquisitionOptions,
  ) => Effect.Effect<SourceSnapshot<ArchivePin>, SourceAcquisitionError>;
}

export interface SourceStore {
  readonly session: Effect.Effect<SourceSession, SourceAcquisitionError, Scope.Scope>;
  readonly gc: (options: GcOptions) => Effect.Effect<SourceGcReport, SourceAcquisitionError>;
}
