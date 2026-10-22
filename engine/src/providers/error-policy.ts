import type { Redactor } from "@lando/sdk/secrets";
import type { ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import { redactProviderError } from "./error-redaction.ts";
import type { ProviderErrorMember } from "./output-policy.ts";

export const withProviderErrorRedaction = (
  runtime: RuntimeProviderShape,
  redactor: Redactor,
): RuntimeProviderShape => {
  const effect = <A, R>(value: Effect.Effect<A, ProviderError, R>) =>
    Effect.mapError(value, (error) => redactProviderError(error, redactor));
  const stream = <A, R>(value: Stream.Stream<A, ProviderError, R>) =>
    Stream.mapError(value, (error) => redactProviderError(error, redactor));
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
    removeVolumeSnapshot,
    listVolumeSnapshots,
    inspectResourceNames,
    observeVolume,
    adoptVolume,
  } = runtime;
  const adapters = {
    isAvailable: Effect.mapError(runtime.isAvailable, (error) => redactProviderError(error, redactor)),
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
    start: (target) => effect(runtime.start(target)),
    stop: (target) => effect(runtime.stop(target)),
    restart: (target) => effect(runtime.restart(target)),
    ...(resume === undefined
      ? {}
      : { resume: (target, identity) => effect(resume.call(runtime, target, identity)) }),
    ...(suspend === undefined
      ? {}
      : { suspend: (target, identity) => effect(suspend.call(runtime, target, identity)) }),
    waitForExit: (target, options) => effect(runtime.waitForExit(target, options)),
    destroy: (target, options) => effect(runtime.destroy(target, options)),
    removeObservedService: (observed) => effect(runtime.removeObservedService(observed)),
    ...(quiesceForFileSync === undefined
      ? {}
      : { quiesceForFileSync: (target) => effect(quiesceForFileSync.call(runtime, target)) }),
    readAppEnvironment: (target, names) => effect(runtime.readAppEnvironment(target, names)),
    exec: (target, command) => effect(runtime.exec(target, command)),
    execStream: (target, command) => stream(runtime.execStream(target, command)),
    run: (spec) => effect(runtime.run(spec)),
    runStream: (spec) => stream(runtime.runStream(spec)),
    logs: (target, options) => stream(runtime.logs(target, options)),
    inspect: (target) => effect(runtime.inspect(target)),
    list: (filter) => effect(runtime.list(filter)),
    snapshotVolume: (spec) => effect(runtime.snapshotVolume(spec)),
    ...(removeVolumeSnapshot === undefined
      ? {}
      : { removeVolumeSnapshot: (snapshot) => effect(removeVolumeSnapshot.call(runtime, snapshot)) }),
    ...(listVolumeSnapshots === undefined
      ? {}
      : { listVolumeSnapshots: () => effect(listVolumeSnapshots.call(runtime)) }),
    restoreVolume: (spec) => effect(runtime.restoreVolume(spec)),
    listVolumes: (filter) => effect(runtime.listVolumes(filter)),
    locateVolume: (ref) => effect(runtime.locateVolume(ref)),
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
    exportArtifact: (ref) => stream(runtime.exportArtifact(ref)),
    importArtifact: (data) => effect(runtime.importArtifact(data)),
  } satisfies Pick<RuntimeProviderShape, ProviderErrorMember>;
  // Pick preserves optionality; this empty record also requires adapters for optional members.
  const exhaustive: Record<Exclude<ProviderErrorMember, keyof typeof adapters>, never> = {};
  return { ...runtime, ...adapters, ...exhaustive };
};
