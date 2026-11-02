import { ProviderUnavailableError, ServiceStartError } from "@lando/sdk/errors";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Stream } from "effect";
import { canary, errorFields } from "./error-registry.ts";

export const memberError = new ServiceStartError({
  ...errorFields,
  service: canary,
  logTail: { service: canary, lines: [canary], truncated: true, exitCode: 7, timedOut: true },
});
export const availabilityError = new ProviderUnavailableError(errorFields);

export const failingProvider = (): Required<RuntimeProviderShape> => {
  const fail = () => Effect.fail(memberError);
  const stream = () => Stream.fail(memberError);
  return {
    ...TestRuntimeProvider,
    isAvailable: Effect.fail(availabilityError),
    appliedPlans: fail(),
    cleanupOwnedResources: fail,
    planSetup: fail,
    setup: fail,
    ensureReady: fail(),
    getStatus: fail(),
    getVersions: fail(),
    occupiedPublishPorts: fail,
    matchingPublishPorts: fail,
    openHostProxyBridge: fail,
    openAgentSocketBridge: fail,
    buildArtifact: fail,
    pullArtifact: fail,
    removeArtifact: fail,
    inspectAppliedFileSync: fail,
    prepareFileSyncTargets: fail,
    quiesceRetainedFileSync: fail,
    disposeFileSyncTargets: fail,
    apply: fail,
    start: fail,
    stop: fail,
    restart: fail,
    resume: fail,
    suspend: fail,
    waitForExit: fail,
    destroy: fail,
    removeObservedService: fail,
    quiesceForFileSync: fail,
    readAppEnvironment: fail,
    exec: fail,
    execStream: stream,
    run: fail,
    runStream: stream,
    logs: stream,
    inspect: fail,
    list: fail,
    snapshotVolume: fail,
    removeVolumeSnapshot: fail,
    listVolumeSnapshots: fail,
    restoreVolume: fail,
    listVolumes: fail,
    locateVolume: fail,
    inspectResourceNames: fail,
    observeVolume: fail,
    adoptVolume: fail,
    removeVolume: fail,
    copyToService: fail,
    copyFromService: stream,
    exportArtifact: stream,
    importArtifact: fail,
  };
};
