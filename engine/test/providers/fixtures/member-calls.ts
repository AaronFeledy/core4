import { PortablePath, ProviderId, type VolumeSnapshotRef } from "@lando/sdk/schema";
import type { ProviderError, RuntimeProviderShape } from "@lando/sdk/services";
import { type Effect, type Scope, Stream } from "effect";
import type { ProviderErrorMember } from "../../../src/providers/output-policy.ts";
import { plan, target } from "./error-registry.ts";

const required = <T>(member: T | undefined): T => {
  if (member === undefined) throw new Error("Required test member is missing");
  return member;
};
const command = { command: ["false"] };
const run = { image: "test", command: ["false"], owner: target };
const identity = { containerId: "container", imageIdentity: "image" };
const artifact = { providerId: ProviderId.make("test"), ref: "image" };
const volume = { app: plan.id, store: "data" };
const snapshot: VolumeSnapshotRef = {
  provider: "test",
  id: "snapshot",
  digest: "digest",
  sizeBytes: 0,
  format: "native",
};
const destination = PortablePath.make("/data");
type Invoke = (provider: RuntimeProviderShape) => Effect.Effect<unknown, ProviderError, Scope.Scope>;

export const memberCalls = {
  isAvailable: (p) => p.isAvailable,
  appliedPlans: (p) => required(p.appliedPlans),
  cleanupOwnedResources: (p) => required(p.cleanupOwnedResources)(plan.root, { volumes: false }),
  planSetup: (p) => p.planSetup({ force: false }),
  setup: (p) => p.setup({ providerId: plan.provider, changes: [] }, { force: false }),
  ensureReady: (p) => required(p.ensureReady),
  getStatus: (p) => p.getStatus,
  getVersions: (p) => p.getVersions,
  occupiedPublishPorts: (p) => required(p.occupiedPublishPorts)([]),
  matchingPublishPorts: (p) => required(p.matchingPublishPorts)("container", []),
  openHostProxyBridge: (p) =>
    required(p.openHostProxyBridge)({
      appId: plan.id,
      sessionId: "session",
      loopbackUrl: "http://localhost",
    }),
  openAgentSocketBridge: (p) =>
    required(p.openAgentSocketBridge)({
      appId: plan.id,
      appRoot: plan.root,
      sessionId: "session",
      kind: "ssh",
      upstream: { _tag: "unix", path: plan.root },
      socketName: "agent",
    }),
  buildArtifact: (p) => p.buildArtifact({ app: plan.id, service: target.service, plan, buildKey: "key" }),
  pullArtifact: (p) => p.pullArtifact({ ref: "image" }),
  removeArtifact: (p) => p.removeArtifact(artifact),
  inspectAppliedFileSync: (p) => required(p.inspectAppliedFileSync)(plan),
  prepareFileSyncTargets: (p) => required(p.prepareFileSyncTargets)(plan),
  quiesceRetainedFileSync: (p) => required(p.quiesceRetainedFileSync)(plan),
  disposeFileSyncTargets: (p) => required(p.disposeFileSyncTargets)(plan),
  apply: (p) => p.apply(plan, { reconcile: true }),
  start: (p) => p.start(target),
  stop: (p) => p.stop(target),
  restart: (p) => p.restart(target),
  resume: (p) => required(p.resume)(target, identity),
  suspend: (p) => required(p.suspend)(target, identity),
  waitForExit: (p) => p.waitForExit(target),
  destroy: (p) => p.destroy(target, { volumes: false }),
  removeObservedService: (p) =>
    p.removeObservedService({
      ...target,
      providerId: plan.provider,
      status: "running",
      publications: { status: "unknown" },
    }),
  quiesceForFileSync: (p) => required(p.quiesceForFileSync)(target),
  readAppEnvironment: (p) => p.readAppEnvironment(target, {}),
  exec: (p) => p.exec(target, command),
  execStream: (p) => Stream.runCollect(p.execStream(target, command)),
  run: (p) => p.run(run),
  runStream: (p) => Stream.runCollect(p.runStream(run)),
  logs: (p) => Stream.runCollect(p.logs(target, { follow: false })),
  inspect: (p) => p.inspect(target),
  list: (p) => p.list({}),
  snapshotVolume: (p) => p.snapshotVolume({ volume }),
  removeVolumeSnapshot: (p) => required(p.removeVolumeSnapshot)(snapshot),
  listVolumeSnapshots: (p) => required(p.listVolumeSnapshots)(),
  restoreVolume: (p) => p.restoreVolume({ snapshot, target: volume, expectedTargetGeneration: "generation" }),
  listVolumes: (p) => p.listVolumes({}),
  locateVolume: (p) => p.locateVolume(volume),
  inspectResourceNames: (p) => required(p.inspectResourceNames)({ kind: "volume", limit: 1 }),
  observeVolume: (p) => required(p.observeVolume)(target, destination),
  adoptVolume: (p) => required(p.adoptVolume)(target, destination),
  removeVolume: (p) => p.removeVolume(volume, "generation"),
  copyToService: (p) => p.copyToService(target, { sourcePath: plan.root, targetPath: destination }),
  copyFromService: (p) => Stream.runCollect(p.copyFromService(target, { sourcePath: destination })),
  exportArtifact: (p) => Stream.runCollect(p.exportArtifact(artifact)),
  importArtifact: (p) => p.importArtifact(Stream.empty),
} satisfies Readonly<Record<ProviderErrorMember, Invoke>>;
