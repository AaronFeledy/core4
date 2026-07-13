import { Duration, Effect, Either, Fiber } from "effect";

import {
  DatasetBindingError,
  RemoteDatasetUnsupportedError,
  RemoteEnvNotFoundError,
  RemoteProtectedEnvError,
  TunnelTargetUnresolvedError,
} from "../errors/index.ts";
import type {
  CommandSpec,
  DataEndpoint,
  DatasetContext,
  DatasetKind,
  DownloadRequest,
  RemoteConfig,
  RemoteEnvId,
  TunnelSession,
  TunnelTarget,
} from "../schema/index.ts";
import type { DatasetShape, LandoEvent, RemoteSourceShape, TunnelServiceShape } from "../services/index.ts";
import { ContractFailure, TEST_APP_ID } from "./_shared.ts";

export interface RemoteSourceContractObservations {
  readonly egressRequests: () => Effect.Effect<ReadonlyArray<RemoteSourceEgressRecord>>;
  readonly toolProvisions: () => Effect.Effect<ReadonlyArray<RemoteSourceToolProvisionRecord>>;
  readonly datasetDelegations: () => Effect.Effect<ReadonlyArray<RemoteSourceDatasetDelegationRecord>>;
  readonly finalizers: () => Effect.Effect<ReadonlyArray<RemoteSourceFinalizerRecord>>;
  readonly probes: () => Effect.Effect<ReadonlyArray<RemoteSourceProbeRecord>>;
}

export interface RemoteSourceEgressRecord {
  readonly request: { readonly url: string; readonly allowFileSource?: boolean; readonly headers?: unknown };
}

export interface RemoteSourceToolProvisionRecord {
  readonly request: DownloadRequest;
}

export interface RemoteSourceDatasetDelegationRecord {
  readonly operation: "fetch" | "send";
  readonly endpoint: DataEndpoint;
}

export interface RemoteSourceFinalizerRecord {
  readonly operation: "fetch" | "send";
  readonly remote: string;
}

export interface RemoteSourceProbeRecord {
  readonly remote: string;
  readonly env?: RemoteEnvId;
}

export interface RemoteSourceContractHarness {
  readonly name?: string;
  readonly source: RemoteSourceShape;
  readonly noPushSource: RemoteSourceShape;
  readonly config: RemoteConfig;
  readonly supportedEnv: RemoteEnvId;
  readonly protectedEnv: RemoteEnvId;
  readonly missingEnv: RemoteEnvId;
  readonly supportedDataset: DatasetKind;
  readonly unsupportedDataset: DatasetKind;
  readonly artifact: DataEndpoint;
  readonly observations: RemoteSourceContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

export interface DatasetContractObservations {
  readonly dataMoverTransfers: () => Effect.Effect<ReadonlyArray<DatasetDataMoverRecord>>;
  readonly dataMoverStreams: () => Effect.Effect<ReadonlyArray<DatasetDataMoverRecord>>;
}

export interface DatasetDataMoverRecord {
  readonly operation: "capture" | "apply";
  readonly endpoint: DataEndpoint;
  readonly command?: CommandSpec | undefined;
}

export interface DatasetContractHarness {
  readonly name?: string;
  readonly dataset: DatasetShape;
  readonly context: DatasetContext;
  readonly codeTreeContext: DatasetContext;
  readonly expectedBytes: Uint8Array;
  readonly observations: DatasetContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly readAppliedBytes: () => Effect.Effect<Uint8Array | null>;
}

const remoteSyncContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Remote sync contract failed: ${assertion}`, assertion, details });

const requireRemoteSyncContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(remoteSyncContractFailure(assertion, details));

const mapRemoteSyncFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    remoteSyncContractFailure(assertion, details);

const sameBytePayload = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null && left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const eventJson = (events: ReadonlyArray<LandoEvent>): string => JSON.stringify(events);

const commandIncludesCredential = (
  record: DatasetDataMoverRecord,
  credentials: ReadonlyArray<string>,
): boolean =>
  record.command !== undefined &&
  credentials.some(
    (credential) => credential.length > 0 && JSON.stringify(record.command).includes(credential),
  );

const stringValues = (record: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<string> =>
  Object.values(record ?? {}).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

export const runRemoteSourceContract = (
  harness: RemoteSourceContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const source = harness.source;

    yield* requireRemoteSyncContract(source.id.length > 0, "RemoteSource declares a non-empty id", source.id);
    yield* requireRemoteSyncContract(
      source.capabilities.environments === true,
      "RemoteSource declares environment listing capability",
      source.capabilities,
    );
    yield* requireRemoteSyncContract(
      source.capabilities.datasets.includes(harness.supportedDataset),
      "RemoteSource capabilities include the supported dataset",
      source.capabilities,
    );

    const firstEnvs = yield* source
      .listEnvironments(harness.config)
      .pipe(Effect.mapError(mapRemoteSyncFailure("listEnvironments resolves")));
    const secondEnvs = yield* source
      .listEnvironments(harness.config)
      .pipe(Effect.mapError(mapRemoteSyncFailure("listEnvironments is repeatable")));
    yield* requireRemoteSyncContract(
      JSON.stringify(firstEnvs) === JSON.stringify(secondEnvs) &&
        firstEnvs.some((env) => env.id === harness.supportedEnv) &&
        firstEnvs.some((env) => env.id === harness.protectedEnv && env.protected === true),
      "listEnvironments is deterministic and includes normal + protected envs",
      { firstEnvs, secondEnvs },
    );

    const locator = yield* source
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve returns a locator for a supported env/dataset")));
    const locatorAgain = yield* source
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve is repeatable")));
    yield* requireRemoteSyncContract(
      JSON.stringify(locator) === JSON.stringify(locatorAgain) &&
        locator.env === harness.supportedEnv &&
        locator.dataset === harness.supportedDataset,
      "resolve is deterministic and echoes env/dataset",
      { locator, locatorAgain },
    );

    const missingEnv = yield* Effect.either(
      source.resolve(harness.config, harness.missingEnv, harness.supportedDataset),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(missingEnv) && missingEnv.left instanceof RemoteEnvNotFoundError,
      "unknown env fails RemoteEnvNotFoundError",
      missingEnv,
    );

    const unsupportedDataset = yield* Effect.either(
      source.resolve(harness.config, harness.supportedEnv, harness.unsupportedDataset),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(unsupportedDataset) && unsupportedDataset.left instanceof RemoteDatasetUnsupportedError,
      "unknown dataset fails RemoteDatasetUnsupportedError",
      unsupportedDataset,
    );

    const egressBefore = (yield* harness.observations.egressRequests()).length;
    const toolBefore = (yield* harness.observations.toolProvisions()).length;
    const delegationsBefore = (yield* harness.observations.datasetDelegations()).length;
    const finalizersBefore = (yield* harness.observations.finalizers()).length;
    const fetched = yield* Effect.scoped(source.fetch(locator)).pipe(
      Effect.mapError(mapRemoteSyncFailure("fetch resolves under a Scope")),
    );
    yield* requireRemoteSyncContract(
      fetched._tag === "hostArchive" || fetched._tag === "stream" || fetched._tag === "artifact",
      "fetch returns a portable DataEndpoint",
      fetched,
    );
    const egressAfterFetch = yield* harness.observations.egressRequests();
    const toolsAfterFetch = yield* harness.observations.toolProvisions();
    const delegationsAfterFetch = yield* harness.observations.datasetDelegations();
    const finalizersAfterFetch = yield* harness.observations.finalizers();
    const newFetchEgress = egressAfterFetch.slice(egressBefore);
    const newFetchTools = toolsAfterFetch.slice(toolBefore);
    const newFetchDelegations = delegationsAfterFetch.slice(delegationsBefore);
    const newFetchFinalizers = finalizersAfterFetch.slice(finalizersBefore);
    const toolProvisioningSatisfied =
      source.capabilities.tool === undefined ||
      (newFetchTools.length > 0 &&
        newFetchTools.some(
          (record) =>
            record.request.destination.kind === "memory" &&
            record.request.url.startsWith("https://") &&
            record.request.callerId?.includes("tool-provision") === true,
        ));
    yield* requireRemoteSyncContract(
      newFetchEgress.some((record) => record.request.url === locator.endpoint) &&
        toolProvisioningSatisfied &&
        newFetchDelegations.some(
          (record) => record.operation === "fetch" && record.endpoint._tag === fetched._tag,
        ) &&
        newFetchFinalizers.some((record) => record.operation === "fetch" && record.remote === source.id),
      "fetch records egress, tool provisioning, dataset delegation, and Scope finalization",
      {
        before: { egressBefore, toolBefore, delegationsBefore, finalizersBefore },
        after: { egressAfterFetch, toolsAfterFetch, delegationsAfterFetch, finalizersAfterFetch },
      },
    );

    const fetchInterruptFinalizersBefore = (yield* harness.observations.finalizers()).length;
    const fetchFiber = yield* Effect.fork(
      Effect.scoped(source.fetch(locator, { expectedDigest: "interrupt-contract" })),
    );
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(fetchFiber);
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > fetchInterruptFinalizersBefore,
      "interrupted fetch finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const noPushLocator = yield* harness.noPushSource
      .resolve(harness.config, harness.supportedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("no-push source resolves supported locator")));
    const noPushSend = yield* Effect.either(
      Effect.scoped(harness.noPushSource.send(noPushLocator, harness.artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(noPushSend) && noPushSend.left instanceof RemoteDatasetUnsupportedError,
      "push is rejected when capabilities.push is false",
      noPushSend,
    );

    const protectedLocator = yield* source
      .resolve(harness.config, harness.protectedEnv, harness.supportedDataset)
      .pipe(Effect.mapError(mapRemoteSyncFailure("resolve returns a protected locator")));
    const protectedWithoutForce = yield* Effect.either(
      Effect.scoped(source.send(protectedLocator, harness.artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(protectedWithoutForce) && protectedWithoutForce.left instanceof RemoteProtectedEnvError,
      "protected env push requires explicit confirmation",
      protectedWithoutForce,
    );

    const sendEgressBefore = (yield* harness.observations.egressRequests()).length;
    const sendDelegationsBefore = (yield* harness.observations.datasetDelegations()).length;
    const sendFinalizersBefore = (yield* harness.observations.finalizers()).length;
    yield* Effect.scoped(
      source.send(protectedLocator, harness.artifact, { protectedEnvConfirmed: true }),
    ).pipe(Effect.mapError(mapRemoteSyncFailure("confirmed protected send resolves under a Scope")));
    const egressAfterSend = yield* harness.observations.egressRequests();
    const delegationsAfterSend = yield* harness.observations.datasetDelegations();
    const finalizersAfterSend = yield* harness.observations.finalizers();
    const newSendEgress = egressAfterSend.slice(sendEgressBefore);
    const newSendDelegations = delegationsAfterSend.slice(sendDelegationsBefore);
    const newSendFinalizers = finalizersAfterSend.slice(sendFinalizersBefore);
    yield* requireRemoteSyncContract(
      newSendFinalizers.some((record) => record.operation === "send" && record.remote === source.id) &&
        newSendEgress.some((record) => record.request.url === protectedLocator.endpoint) &&
        newSendDelegations.some(
          (record) => record.operation === "send" && record.endpoint._tag === harness.artifact._tag,
        ),
      "send records egress, dataset delegation, and Scope finalization",
      {
        before: {
          egressBefore: sendEgressBefore,
          delegationsBefore: sendDelegationsBefore,
          finalizersBefore: sendFinalizersBefore,
        },
        after: { egressAfterSend, delegationsAfterSend, finalizersAfterSend },
      },
    );

    const sendInterruptFinalizersBefore = (yield* harness.observations.finalizers()).length;
    const sendFiber = yield* Effect.fork(
      Effect.scoped(
        source.send(protectedLocator, harness.artifact, {
          protectedEnvConfirmed: true,
          expectedDigest: "interrupt-contract",
        }),
      ),
    );
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(sendFiber);
    yield* requireRemoteSyncContract(
      (yield* harness.observations.finalizers()).length > sendInterruptFinalizersBefore,
      "interrupted send finalizes Scope-bound resources",
      yield* harness.observations.finalizers(),
    );

    const probesBefore = (yield* harness.observations.probes()).length;
    const testResult = yield* (
      source.test?.(harness.config, harness.supportedEnv) ??
      Effect.fail(remoteSyncContractFailure("RemoteSource exposes a readiness test method"))
    ).pipe(Effect.mapError(mapRemoteSyncFailure("readiness test resolves")));
    yield* requireRemoteSyncContract(
      testResult.ok === true &&
        (yield* harness.observations.probes()).length > probesBefore &&
        (yield* harness.observations.probes()).some(
          (record) => record.remote === source.id && record.env === harness.supportedEnv,
        ),
      "readiness uses the probe/test seam instead of ad-hoc retry",
      testResult,
    );

    const events = yield* harness.events();
    yield* requireRemoteSyncContract(
      events.some((event) => event.eventName === "pre-dataset-fetch") &&
        events.some((event) => event.eventName === "post-dataset-fetch") &&
        events.some((event) => event.eventName === "pre-dataset-send") &&
        events.some((event) => event.eventName === "post-dataset-send"),
      "fetch/send emit Sync lifecycle events",
      events,
    );
    const remoteSecretValues = [
      ...Object.entries(harness.config)
        .filter(([key]) => key !== "source")
        .flatMap(([, value]) => (typeof value === "string" ? [value] : [])),
      ...stringValues(locator.metadata),
      ...stringValues(protectedLocator.metadata),
    ];
    yield* requireRemoteSyncContract(
      remoteSecretValues.every((secret) => !eventJson(events).includes(secret)),
      "RemoteSource lifecycle events redact tokens and remote secrets",
      { remoteSecretValues, events },
    );
  });

export const runDatasetContract = (harness: DatasetContractHarness): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const dataset = harness.dataset;

    yield* requireRemoteSyncContract(dataset.id.length > 0, "Dataset declares a non-empty id", dataset.id);
    yield* requireRemoteSyncContract(
      dataset.capabilities.capture === true && dataset.capabilities.apply === true,
      "Dataset declares capture/apply capabilities honestly",
      dataset.capabilities,
    );
    yield* requireRemoteSyncContract(
      dataset.artifactFormat.endpoint === "hostArchive" || dataset.artifactFormat.endpoint === "stream",
      "Dataset declares a portable artifact format",
      dataset.artifactFormat,
    );

    const localStore = yield* dataset
      .localStore(harness.context)
      .pipe(Effect.mapError(mapRemoteSyncFailure("localStore resolves")));
    yield* requireRemoteSyncContract(localStore !== null, "Dataset reports its local store", localStore);

    const transfersBefore = (yield* harness.observations.dataMoverTransfers()).length;
    const streamsBefore = (yield* harness.observations.dataMoverStreams()).length;
    const artifact = yield* Effect.scoped(dataset.capture(harness.context)).pipe(
      Effect.mapError(mapRemoteSyncFailure("capture produces an artifact")),
    );
    yield* requireRemoteSyncContract(
      artifact._tag === "hostArchive" || artifact._tag === "stream" || artifact._tag === "artifact",
      "capture returns a portable DataEndpoint",
      artifact,
    );
    const applied = yield* Effect.scoped(dataset.apply(harness.context, artifact, { snapshot: true })).pipe(
      Effect.mapError(mapRemoteSyncFailure("apply consumes the artifact")),
    );
    yield* requireRemoteSyncContract(applied.changed === true, "first apply reports a change", applied);
    const appliedBytes = yield* harness.readAppliedBytes();
    yield* requireRemoteSyncContract(
      sameBytePayload(appliedBytes, harness.expectedBytes),
      "capture -> apply round-trips dataset bytes",
      { expected: Array.from(harness.expectedBytes), actual: appliedBytes ? Array.from(appliedBytes) : null },
    );
    const transfersAfterApply = yield* harness.observations.dataMoverTransfers();
    const streamsAfterApply = yield* harness.observations.dataMoverStreams();
    const newApplyTransfers = transfersAfterApply.slice(transfersBefore);
    const newApplyStreams = streamsAfterApply.slice(streamsBefore);
    yield* requireRemoteSyncContract(
      newApplyTransfers.length >= 2 &&
        newApplyTransfers.some(
          (record) => record.operation === "capture" && record.endpoint._tag === artifact._tag,
        ) &&
        newApplyTransfers.some(
          (record) => record.operation === "apply" && record.endpoint._tag === artifact._tag,
        ) &&
        newApplyStreams.some(
          (record) => record.operation === "capture" && record.endpoint._tag === artifact._tag,
        ),
      "capture/apply delegate byte movement to DataMover hooks",
      {
        before: { transfersBefore, streamsBefore },
        after: { transfers: transfersAfterApply, streams: streamsAfterApply },
      },
    );
    const credentialValues = Object.values(harness.context.creds ?? {});
    yield* requireRemoteSyncContract(
      [...newApplyTransfers, ...newApplyStreams].every(
        (record) => !commandIncludesCredential(record, credentialValues),
      ),
      "Dataset credentials are not passed through service command argv",
      { credentials: credentialValues, transfers: newApplyTransfers, streams: newApplyStreams },
    );

    const replay = yield* Effect.scoped(dataset.apply(harness.context, artifact)).pipe(
      Effect.mapError(mapRemoteSyncFailure("replay apply resolves")),
    );
    yield* requireRemoteSyncContract(
      replay.changed === false,
      "apply is idempotent/replay-safe for the same artifact",
      replay,
    );

    const codeTreeCapture = yield* Effect.either(Effect.scoped(dataset.capture(harness.codeTreeContext)));
    const codeTreeApply = yield* Effect.either(
      Effect.scoped(dataset.apply(harness.codeTreeContext, artifact)),
    );
    yield* requireRemoteSyncContract(
      Either.isLeft(codeTreeCapture) &&
        codeTreeCapture.left instanceof DatasetBindingError &&
        Either.isLeft(codeTreeApply) &&
        codeTreeApply.left instanceof DatasetBindingError,
      "code-tree-targeting bindings fail DatasetBindingError",
      { codeTreeCapture, codeTreeApply },
    );

    const events = yield* harness.events();
    yield* requireRemoteSyncContract(
      events.some((event) => event.eventName === "pre-dataset-capture") &&
        events.some((event) => event.eventName === "post-dataset-capture") &&
        events.some((event) => event.eventName === "pre-dataset-apply") &&
        events.some((event) => event.eventName === "post-dataset-apply"),
      "Dataset emits capture/apply lifecycle events",
      events,
    );
    yield* requireRemoteSyncContract(
      credentialValues.every((secret) => !eventJson(events).includes(secret)),
      "Dataset lifecycle events redact credentials and dataset secrets",
      { credentialValues, events },
    );
  });

export const makeRemoteSourceContractSuite = runRemoteSourceContract;
export const makeDatasetContractSuite = runDatasetContract;

export type TunnelServiceEgressRecord = { readonly url: string; readonly callerId?: string | undefined };
export type TunnelServiceToolProvisionRecord = { readonly request: DownloadRequest };
export type TunnelServiceFinalizerRecord = { readonly sessionId: string; readonly provider: string };
export type TunnelServiceDetachedStateRecord = {
  readonly operation: "record" | "reconcile" | "remove";
  readonly sessionId: string;
};
export type TunnelServiceProbeRecord = {
  readonly sessionId: string;
  readonly publicUrl?: string | undefined;
};

export interface TunnelServiceContractObservations {
  readonly egressRequests: () => Effect.Effect<ReadonlyArray<TunnelServiceEgressRecord>>;
  readonly toolProvisions: () => Effect.Effect<ReadonlyArray<TunnelServiceToolProvisionRecord>>;
  readonly finalizers: () => Effect.Effect<ReadonlyArray<TunnelServiceFinalizerRecord>>;
  readonly detachedState: () => Effect.Effect<ReadonlyArray<TunnelServiceDetachedStateRecord>>;
  readonly probes: () => Effect.Effect<ReadonlyArray<TunnelServiceProbeRecord>>;
  readonly dataMoverUses: () => Effect.Effect<ReadonlyArray<unknown>>;
  readonly redactionTokens: ReadonlyArray<string>;
}

export interface TunnelServiceContractHarness {
  readonly name: string;
  readonly service: TunnelServiceShape;
  readonly unsupportedTarget: TunnelTarget;
  readonly observations: TunnelServiceContractObservations;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

const tunnelContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `TunnelService contract failed: ${assertion}`, assertion, details });

const requireTunnelContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(tunnelContractFailure(assertion, details));

const mapTunnelFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    tunnelContractFailure(assertion, details);

const tunnelEventJson = (events: ReadonlyArray<LandoEvent>): string => JSON.stringify(events);

export const runTunnelServiceContract = (
  harness: TunnelServiceContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const target: TunnelTarget = { _tag: "route", routeId: "https", hostname: "app.lndo.site" };

    yield* requireTunnelContract(service.id.length > 0, "TunnelService declares a non-empty id", service.id);
    yield* requireTunnelContract(
      typeof service.capabilities.ephemeralUrls === "boolean" &&
        typeof service.capabilities.detached === "boolean" &&
        typeof service.capabilities.connectorBinary === "boolean",
      "TunnelService declares capability flags honestly",
      service.capabilities,
    );

    const unsupportedStart = yield* Effect.either(
      Effect.scoped(service.start({ app: TEST_APP_ID, target: harness.unsupportedTarget })),
    );
    yield* requireTunnelContract(
      Either.isLeft(unsupportedStart) && unsupportedStart.left instanceof TunnelTargetUnresolvedError,
      "unsupported app target fails TunnelTargetUnresolvedError",
      unsupportedStart,
    );

    const egressBefore = (yield* harness.observations.egressRequests()).length;
    const toolsBefore = (yield* harness.observations.toolProvisions()).length;
    const probesBefore = (yield* harness.observations.probes()).length;
    const finalizersBefore = (yield* harness.observations.finalizers()).length;
    const session = yield* Effect.scoped(service.start({ app: TEST_APP_ID, target })).pipe(
      Effect.mapError(mapTunnelFailure("foreground start resolves under a Scope")),
    );
    yield* requireTunnelContract(
      session.provider === service.id && session.status === "ready" && session.detached === false,
      "foreground start returns a ready session for the selected provider",
      session,
    );
    const egressAfterStart = yield* harness.observations.egressRequests();
    const toolsAfterStart = yield* harness.observations.toolProvisions();
    const probesAfterStart = yield* harness.observations.probes();
    const finalizersAfterStart = yield* harness.observations.finalizers();
    const toolSatisfied =
      service.capabilities.connectorBinary === false ||
      toolsAfterStart.slice(toolsBefore).some((record) => record.request.url.startsWith("https://"));
    yield* requireTunnelContract(
      egressAfterStart.slice(egressBefore).some((record) => record.url.startsWith("https://")) &&
        toolSatisfied &&
        probesAfterStart.slice(probesBefore).some((record) => record.sessionId === session.id) &&
        finalizersAfterStart.slice(finalizersBefore).some((record) => record.sessionId === session.id),
      "start records HttpClient egress, tool provisioning, readiness probe, and Scope finalization",
      { egressAfterStart, toolsAfterStart, probesAfterStart, finalizersAfterStart },
    );

    const status = yield* service
      .status({ sessionId: session.id })
      .pipe(Effect.mapError(mapTunnelFailure("status resolves for a started session")));
    const listed = yield* service
      .list({ app: TEST_APP_ID })
      .pipe(Effect.mapError(mapTunnelFailure("list resolves for an app filter")));
    yield* requireTunnelContract(
      status === "ready" && listed.some((entry) => entry.id === session.id),
      "status/list report a started session",
      { status, listed },
    );
    yield* service
      .stop({ sessionId: session.id })
      .pipe(Effect.mapError(mapTunnelFailure("stop resolves for a started session")));
    const stopped = yield* service
      .status({ sessionId: session.id })
      .pipe(Effect.mapError(mapTunnelFailure("status resolves after stop")));
    yield* requireTunnelContract(stopped === "stopped", "stop updates session status to stopped", stopped);

    let detached: TunnelSession | undefined;
    if (service.capabilities.detached) {
      detached = yield* Effect.scoped(service.start({ app: TEST_APP_ID, target, detached: true })).pipe(
        Effect.mapError(mapTunnelFailure("detached start resolves when advertised")),
      );
    }
    if (detached !== undefined) {
      yield* requireTunnelContract(
        detached.detached === true,
        "detached start returns a detached session when advertised",
        detached,
      );
    }
    if (detached !== undefined) {
      const detachedStatus = yield* service
        .status({ sessionId: detached.id })
        .pipe(Effect.mapError(mapTunnelFailure("status resolves for a detached session")));
      const detachedListed = yield* service
        .list({ app: TEST_APP_ID })
        .pipe(Effect.mapError(mapTunnelFailure("list resolves for a detached session")));
      yield* requireTunnelContract(
        detachedStatus === "ready" && detachedListed.some((entry) => entry.id === detached.id),
        "status/list reconcile detached session state when advertised",
        { status: detachedStatus, listed: detachedListed },
      );
      yield* service
        .stop({ sessionId: detached.id })
        .pipe(Effect.mapError(mapTunnelFailure("stop resolves for a detached session")));
      const detachedStopped = yield* service
        .status({ sessionId: detached.id })
        .pipe(Effect.mapError(mapTunnelFailure("status resolves after detached stop")));
      yield* requireTunnelContract(
        detachedStopped === "stopped",
        "detached stop updates session status to stopped when advertised",
        detachedStopped,
      );
    }

    const finalizersBeforeInterrupt = (yield* harness.observations.finalizers()).length;
    const fiber = yield* Effect.fork(Effect.scoped(service.start({ app: TEST_APP_ID, target })));
    yield* Effect.sleep(Duration.millis(1));
    yield* Fiber.interrupt(fiber);
    yield* requireTunnelContract(
      (yield* harness.observations.finalizers()).length > finalizersBeforeInterrupt,
      "interrupted foreground start finalizes connector resources",
      yield* harness.observations.finalizers(),
    );

    const detachedRecords = yield* harness.observations.detachedState();
    if (detached !== undefined) {
      yield* requireTunnelContract(
        detachedRecords.some((record) => record.operation === "record" && record.sessionId === detached.id) &&
          detachedRecords.some(
            (record) => record.operation === "reconcile" && record.sessionId === detached.id,
          ) &&
          detachedRecords.some((record) => record.operation === "remove" && record.sessionId === detached.id),
        "detached sessions record, reconcile, and remove StateStore-backed state when advertised",
        detachedRecords,
      );
    }

    const events = yield* harness.events();
    yield* requireTunnelContract(
      events.some((event) => event.eventName === "pre-tunnel-start") &&
        events.some((event) => event.eventName === "post-tunnel-start") &&
        events.some((event) => event.eventName === "tunnel-ready") &&
        events.some((event) => event.eventName === "pre-tunnel-stop") &&
        events.some((event) => event.eventName === "post-tunnel-stop") &&
        events.some((event) => event.eventName === "tunnel-status"),
      "TunnelService emits the Tunnel lifecycle event scope",
      events,
    );
    yield* requireTunnelContract(
      harness.observations.redactionTokens.every((secret) => !tunnelEventJson(events).includes(secret)),
      "Tunnel lifecycle events redact public URLs, auth URLs, and tokens",
      { tokens: harness.observations.redactionTokens, events },
    );
    yield* requireTunnelContract(
      (yield* harness.observations.dataMoverUses()).length === 0,
      "TunnelService never delegates local byte movement through DataMover",
      yield* harness.observations.dataMoverUses(),
    );
  });

export const makeTunnelServiceContractSuite = runTunnelServiceContract;
