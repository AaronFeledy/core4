import type { AppSelector, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

type OutputPolicy =
  | "metadata"
  | "lifecycle"
  | "app-output"
  | "owner-output"
  | "artifact-bytes"
  | "environment-read";

type ErrorChannel<T> = NonNullable<T> extends Effect.Effect<infer _A, infer _E, infer _R>
  ? "effect"
  : NonNullable<T> extends Stream.Stream<infer _A, infer _E, infer _R>
    ? "stream"
    : NonNullable<T> extends (...args: never[]) => Effect.Effect<infer _A, infer _E, infer _R>
      ? "effect"
      : NonNullable<T> extends (...args: never[]) => Stream.Stream<infer _A, infer _E, infer _R>
        ? "stream"
        : "none";
type MemberPolicy<K extends keyof RuntimeProviderShape> = readonly [
  OutputPolicy,
  ErrorChannel<RuntimeProviderShape[K]>,
];

export const providerMemberPolicy = {
  id: ["metadata", "none"],
  displayName: ["metadata", "none"],
  version: ["metadata", "none"],
  platform: ["metadata", "none"],
  capabilities: ["metadata", "none"],
  isAvailable: ["lifecycle", "effect"],
  appliedPlans: ["metadata", "effect"],
  cleanupOwnedResources: ["lifecycle", "effect"],
  planSetup: ["lifecycle", "effect"],
  setup: ["lifecycle", "effect"],
  ensureReady: ["lifecycle", "effect"],
  getStatus: ["metadata", "effect"],
  getVersions: ["metadata", "effect"],
  occupiedPublishPorts: ["metadata", "effect"],
  matchingPublishPorts: ["metadata", "effect"],
  openHostProxyBridge: ["lifecycle", "effect"],
  openAgentSocketBridge: ["lifecycle", "effect"],
  buildArtifact: ["lifecycle", "effect"],
  pullArtifact: ["lifecycle", "effect"],
  removeArtifact: ["lifecycle", "effect"],
  inspectAppliedFileSync: ["metadata", "effect"],
  prepareFileSyncTargets: ["lifecycle", "effect"],
  quiesceRetainedFileSync: ["lifecycle", "effect"],
  disposeFileSyncTargets: ["lifecycle", "effect"],
  apply: ["lifecycle", "effect"],
  start: ["lifecycle", "effect"],
  stop: ["lifecycle", "effect"],
  restart: ["lifecycle", "effect"],
  resume: ["lifecycle", "effect"],
  suspend: ["lifecycle", "effect"],
  waitForExit: ["lifecycle", "effect"],
  destroy: ["lifecycle", "effect"],
  removeObservedService: ["lifecycle", "effect"],
  quiesceForFileSync: ["lifecycle", "effect"],
  readAppEnvironment: ["environment-read", "effect"],
  exec: ["app-output", "effect"],
  execStream: ["app-output", "stream"],
  run: ["owner-output", "effect"],
  runStream: ["owner-output", "stream"],
  logs: ["app-output", "stream"],
  inspect: ["metadata", "effect"],
  list: ["metadata", "effect"],
  snapshotVolume: ["lifecycle", "effect"],
  removeVolumeSnapshot: ["lifecycle", "effect"],
  listVolumeSnapshots: ["metadata", "effect"],
  restoreVolume: ["lifecycle", "effect"],
  listVolumes: ["metadata", "effect"],
  locateVolume: ["metadata", "effect"],
  inspectResourceNames: ["metadata", "effect"],
  observeVolume: ["metadata", "effect"],
  adoptVolume: ["lifecycle", "effect"],
  removeVolume: ["lifecycle", "effect"],
  copyToService: ["lifecycle", "effect"],
  copyFromService: ["app-output", "stream"],
  exportArtifact: ["artifact-bytes", "stream"],
  importArtifact: ["lifecycle", "effect"],
} as const satisfies { readonly [K in keyof RuntimeProviderShape]-?: MemberPolicy<K> };

export type ProviderErrorMember = {
  [K in keyof typeof providerMemberPolicy]: (typeof providerMemberPolicy)[K][1] extends "none" ? never : K;
}[keyof typeof providerMemberPolicy];

type OutputMember = {
  [K in keyof typeof providerMemberPolicy]: (typeof providerMemberPolicy)[K][0] extends
    | "app-output"
    | "owner-output"
    ? K
    : never;
}[keyof typeof providerMemberPolicy];

export const withOutputRegistration = (
  runtime: RuntimeProviderShape,
  register: (target: AppSelector) => Effect.Effect<void, ProviderError>,
): RuntimeProviderShape => {
  const before = (target: AppSelector | undefined) => (target === undefined ? Effect.void : register(target));
  const adapters = {
    exec: (target, command) => before(target).pipe(Effect.flatMap(() => runtime.exec(target, command))),
    execStream: (target, command) =>
      Stream.unwrap(
        before(target).pipe(Effect.as(Stream.suspend(() => runtime.execStream(target, command)))),
      ),
    logs: (target, options) =>
      Stream.unwrap(before(target).pipe(Effect.as(Stream.suspend(() => runtime.logs(target, options))))),
    run: (spec) => before(spec.owner).pipe(Effect.flatMap(() => runtime.run(spec))),
    runStream: (spec) =>
      Stream.unwrap(before(spec.owner).pipe(Effect.as(Stream.suspend(() => runtime.runStream(spec))))),
    copyFromService: (target, spec) =>
      Stream.unwrap(
        before(target).pipe(Effect.as(Stream.suspend(() => runtime.copyFromService(target, spec)))),
      ),
  } satisfies Pick<RuntimeProviderShape, OutputMember>;
  return { ...runtime, ...adapters };
};
