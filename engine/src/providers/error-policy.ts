import { redactProviderCause } from "@lando/redaction/provider-error";
import type { Redactor } from "@lando/sdk/secrets";
import type { RuntimeProviderShape, VolumeArchiveImportSpec } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import type { ProviderErrorMember } from "./output-policy.ts";

export const withProviderErrorRedaction = (
  runtime: RuntimeProviderShape,
  redactor: Redactor,
): RuntimeProviderShape => {
  // Archive and beforeCommit failures that belong to the caller pass through; provider errors are redacted
  // wherever they sit in the Cause, keeping every reason.
  const effect = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.catchCause(self, (cause) => Effect.failCause(redactProviderCause(cause, redactor)));
  const stream = <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    Stream.catchCause(self, (cause) => Stream.failCause(redactProviderCause(cause, redactor)));
  const {
    appliedPlans,
    cleanupOwnedResources,
    ensureReady,
    occupiedPublishPorts,
    matchingPublishPorts,
    openHostProxyBridge,
    openAgentSocketBridge,
    inspectAppliedFileSync,
    prepareFileSyncTargets,
    quiesceRetainedFileSync,
    disposeFileSyncTargets,
    resume,
    suspend,
    quiesceForFileSync,
    listVolumeSnapshots,
    adoptDataRoot,
    inspectResourceNames,
    observeVolume,
    adoptVolume,
  } = runtime;
  const adapters = {
    isAvailable: effect(runtime.isAvailable),
    ...(appliedPlans === undefined ? {} : { appliedPlans: effect(appliedPlans) }),
    ...(cleanupOwnedResources === undefined
      ? {}
      : {
          cleanupOwnedResources: (root, options) =>
            effect(cleanupOwnedResources.call(runtime, root, options)),
        }),
    planSetup: (options) => effect(runtime.planSetup(options)),
    setup: (plan, options) => effect(runtime.setup(plan, options)),
    ...(ensureReady === undefined ? {} : { ensureReady: effect(ensureReady) }),
    getStatus: effect(runtime.getStatus),
    getVersions: effect(runtime.getVersions),
    ...(occupiedPublishPorts === undefined
      ? {}
      : { occupiedPublishPorts: (ports) => effect(occupiedPublishPorts.call(runtime, ports)) }),
    ...(matchingPublishPorts === undefined
      ? {}
      : {
          matchingPublishPorts: (container, ports) =>
            effect(matchingPublishPorts.call(runtime, container, ports)),
        }),
    ...(openHostProxyBridge === undefined
      ? {}
      : { openHostProxyBridge: (input) => effect(openHostProxyBridge.call(runtime, input)) }),
    ...(openAgentSocketBridge === undefined
      ? {}
      : { openAgentSocketBridge: (input) => effect(openAgentSocketBridge.call(runtime, input)) }),
    buildArtifact: (spec) => effect(runtime.buildArtifact(spec)),
    pullArtifact: (spec) => effect(runtime.pullArtifact(spec)),
    removeArtifact: (ref) => effect(runtime.removeArtifact(ref)),
    listArtifacts: (selector) => effect(runtime.listArtifacts(selector)),
    ...(inspectAppliedFileSync === undefined
      ? {}
      : { inspectAppliedFileSync: (plan) => effect(inspectAppliedFileSync.call(runtime, plan)) }),
    ...(prepareFileSyncTargets === undefined
      ? {}
      : { prepareFileSyncTargets: (plan) => effect(prepareFileSyncTargets.call(runtime, plan)) }),
    ...(quiesceRetainedFileSync === undefined
      ? {}
      : { quiesceRetainedFileSync: (plan) => effect(quiesceRetainedFileSync.call(runtime, plan)) }),
    ...(disposeFileSyncTargets === undefined
      ? {}
      : { disposeFileSyncTargets: (plan) => effect(disposeFileSyncTargets.call(runtime, plan)) }),
    apply: (plan, options) => effect(runtime.apply(plan, options)),
    restart: (target) => effect(runtime.restart(target)),
    ...(resume === undefined
      ? {}
      : { resume: (target, identity) => effect(resume.call(runtime, target, identity)) }),
    ...(suspend === undefined
      ? {}
      : { suspend: (target, identity) => effect(suspend.call(runtime, target, identity)) }),
    waitForExit: (target, options) => effect(runtime.waitForExit(target, options)),
    bringDown: (target, options) => effect(runtime.bringDown(target, options)),
    bringDownObserved: (observed, containers) => effect(runtime.bringDownObserved(observed, containers)),
    ...(quiesceForFileSync === undefined
      ? {}
      : { quiesceForFileSync: (target) => effect(quiesceForFileSync.call(runtime, target)) }),
    readAppEnvironment: (target, names) => effect(runtime.readAppEnvironment(target, names)),
    exec: (target, command) => effect(runtime.exec(target, command)),
    execStream: (target, command) => stream(runtime.execStream(target, command)),
    run: (spec) => effect(runtime.run(spec)),
    runStream: (spec) => stream(runtime.runStream(spec)),
    importVolume: <E, R>(spec: VolumeArchiveImportSpec<E, R>) => effect(runtime.importVolume(spec)),
    logs: (target, options) => stream(runtime.logs(target, options)),
    inspect: (target) => effect(runtime.inspect(target)),
    list: (filter) => effect(runtime.list(filter)),
    snapshotVolume: (spec) => effect(runtime.snapshotVolume(spec)),
    removeVolumeSnapshot: (snapshot, options) => effect(runtime.removeVolumeSnapshot(snapshot, options)),
    ...(listVolumeSnapshots === undefined
      ? {}
      : { listVolumeSnapshots: () => effect(listVolumeSnapshots.call(runtime)) }),
    restoreVolume: <E = never>(
      spec: Parameters<RuntimeProviderShape["restoreVolume"]>[0],
      options?: { readonly beforeCommit?: Effect.Effect<void, E> },
    ) => effect(runtime.restoreVolume(spec, options)),
    listVolumes: (filter) => effect(runtime.listVolumes(filter)),
    locateVolume: (ref) => effect(runtime.locateVolume(ref)),
    ...(adoptDataRoot === undefined
      ? {}
      : { adoptDataRoot: (plan, witness) => effect(adoptDataRoot.call(runtime, plan, witness)) }),
    ...(inspectResourceNames === undefined
      ? {}
      : { inspectResourceNames: (query) => effect(inspectResourceNames.call(runtime, query)) }),
    ...(observeVolume === undefined
      ? {}
      : { observeVolume: (target, destination) => effect(observeVolume.call(runtime, target, destination)) }),
    ...(adoptVolume === undefined
      ? {}
      : { adoptVolume: (target, destination) => effect(adoptVolume.call(runtime, target, destination)) }),
    removeVolume: (ref, generation) => effect(runtime.removeVolume(ref, generation)),
    copyToService: (target, spec) => effect(runtime.copyToService(target, spec)),
    copyFromService: (target, spec) => stream(runtime.copyFromService(target, spec)),
    exportVolume: (ref) => stream(runtime.exportVolume(ref)),
    exportArtifact: (ref) => stream(runtime.exportArtifact(ref)),
    importArtifact: (data) => effect(runtime.importArtifact(data)),
  } satisfies Pick<RuntimeProviderShape, ProviderErrorMember>;
  // Pick preserves optionality; this empty record also requires adapters for optional members.
  const exhaustive: Record<Exclude<ProviderErrorMember, keyof typeof adapters>, never> = {};
  return { ...runtime, ...adapters, ...exhaustive };
};
