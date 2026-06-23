import { createHash } from "node:crypto";

import { DateTime, Effect, Schema, Stream } from "effect";

import {
  DatasetApplyError,
  DatasetBindingError,
  DatasetCaptureError,
  RemoteDatasetUnsupportedError,
  RemoteEnvNotFoundError,
  RemoteProtectedEnvError,
  RemoteToolMissingError,
  RemoteUnreachableError,
} from "@lando/sdk/errors";
import type {
  AppPlan,
  CommandSpec,
  DataEndpoint,
  DataTransferProgress,
  DataTransferSpec,
  DatasetContext,
  DatasetKind,
  DownloadRequest,
  RemoteCapabilities,
  RemoteConfig,
  RemoteEnvId,
  RemoteLocator,
  ServiceName,
  VolumeRef,
} from "@lando/sdk/schema";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import type {
  DataMoverShape,
  DatasetShape,
  DownloaderShape,
  LandoEvent,
  RemoteSourceShape,
} from "@lando/sdk/services";

import type { HttpClientShape, HttpStreamRequest } from "../http-client/service.ts";

const TEST_REMOTE_SECRET = "REMOTE-CONTRACT-SECRET-493f61";
const TEST_DATASET_SECRET = "DATASET-CONTRACT-SECRET-8d31f2";
const INTERRUPT_DIGEST = "interrupt-contract";
const TIMESTAMP = DateTime.unsafeMake("2026-06-01T00:00:00.000Z");

const app = AppId.make("remote-contract-app");
const provider = ProviderId.make("test");
const service = "database" as ServiceName;
const supportedEnv = "dev" as RemoteEnvId;
const protectedEnv = "prod" as RemoteEnvId;
const missingEnv = "missing" as RemoteEnvId;
const supportedDataset: DatasetKind = "database";
const unsupportedDataset: DatasetKind = "files";
const artifact: DataEndpoint = {
  _tag: "hostArchive",
  path: AbsolutePath.make("/tmp/lando-remote-sync-contract.tar"),
  format: "tar",
};
const localStore: VolumeRef = { app, store: "database", scope: "app" };

const plan: AppPlan = {
  id: app,
  name: "Remote Contract App",
  slug: "remote-contract-app",
  root: AbsolutePath.make("/tmp/lando-remote-contract-app"),
  provider,
  services: {},
  routes: [],
  networks: [],
  stores: [{ name: "database", scope: "app" }],
  fileSync: [],
  metadata: { resolvedAt: TIMESTAMP, source: "@lando/core/testing", runtime: 4 },
  extensions: {},
};

type RemoteEgressRecord = { readonly request: HttpStreamRequest };
type ToolProvisionRecord = { readonly request: DownloadRequest };
type DatasetDelegationRecord = {
  readonly operation: "fetch" | "send";
  readonly endpoint: DataEndpoint;
};
type FinalizerRecord = { readonly operation: "fetch" | "send"; readonly remote: string };
type ProbeRecord = { readonly remote: string; readonly env?: RemoteEnvId };
type DataMoverRecord = {
  readonly operation: "capture" | "apply";
  readonly endpoint: DataEndpoint;
  readonly command?: CommandSpec | undefined;
};

const emptySha256 = createHash("sha256").update(new Uint8Array()).digest("hex");

const sanitize = (value: string): string =>
  value.replaceAll(TEST_REMOTE_SECRET, "[redacted]").replaceAll(TEST_DATASET_SECRET, "[redacted]");

const event = (value: LandoEvent): LandoEvent => JSON.parse(sanitize(JSON.stringify(value))) as LandoEvent;

export interface TestRemoteSourceObservations {
  readonly egressRequests: () => Effect.Effect<ReadonlyArray<RemoteEgressRecord>>;
  readonly toolProvisions: () => Effect.Effect<ReadonlyArray<ToolProvisionRecord>>;
  readonly datasetDelegations: () => Effect.Effect<ReadonlyArray<DatasetDelegationRecord>>;
  readonly finalizers: () => Effect.Effect<ReadonlyArray<FinalizerRecord>>;
  readonly probes: () => Effect.Effect<ReadonlyArray<ProbeRecord>>;
}

export interface TestRemoteSourceHandle {
  readonly source: RemoteSourceShape;
  readonly noPushSource: RemoteSourceShape;
  readonly config: RemoteConfig;
  readonly supportedEnv: RemoteEnvId;
  readonly protectedEnv: RemoteEnvId;
  readonly missingEnv: RemoteEnvId;
  readonly supportedDataset: DatasetKind;
  readonly unsupportedDataset: DatasetKind;
  readonly artifact: DataEndpoint;
  readonly observations: TestRemoteSourceObservations;
  readonly events: () => ReadonlyArray<LandoEvent>;
}

export interface TestDatasetObservations {
  readonly dataMoverTransfers: () => Effect.Effect<ReadonlyArray<DataMoverRecord>>;
  readonly dataMoverStreams: () => Effect.Effect<ReadonlyArray<DataMoverRecord>>;
}

export interface TestDatasetHandle {
  readonly dataset: DatasetShape;
  readonly context: DatasetContext;
  readonly codeTreeContext: DatasetContext;
  readonly expectedBytes: Uint8Array;
  readonly observations: TestDatasetObservations;
  readonly events: () => ReadonlyArray<LandoEvent>;
  readonly readAppliedBytes: () => Uint8Array | null;
}

const makeRemoteSource = (input: {
  readonly id: string;
  readonly push: boolean;
  readonly captured: Array<LandoEvent>;
  readonly records: {
    readonly egress: Array<RemoteEgressRecord>;
    readonly tools: Array<ToolProvisionRecord>;
    readonly delegations: Array<DatasetDelegationRecord>;
    readonly finalizers: Array<FinalizerRecord>;
    readonly probes: Array<ProbeRecord>;
  };
}): RemoteSourceShape => {
  const capabilities: RemoteCapabilities = {
    environments: true,
    push: input.push,
    datasets: [supportedDataset],
    tool: "test-remote-cli",
    auth: "token",
    protectedByDefault: [protectedEnv],
  };
  const environments = [
    { id: supportedEnv, label: "Development", default: true, datasets: [supportedDataset] },
    { id: protectedEnv, label: "Production", protected: true, datasets: [supportedDataset] },
  ];
  const http: HttpClientShape = {
    id: `${input.id}-remote-http`,
    stream: (request) =>
      Effect.sync(() => {
        input.records.egress.push({ request });
        return {
          status: 200,
          headers: new Map<string, string>(),
          body: Stream.fromIterable([new Uint8Array()]),
        };
      }),
  };
  const downloader: DownloaderShape = {
    id: `${input.id}-tool-downloader`,
    capabilities: {
      schemes: ["https"],
      memoryDownload: true,
      cacheAware: false,
      offline: false,
      mirror: false,
    },
    download: (request) =>
      Effect.sync(() => {
        input.records.tools.push({ request });
        return {
          url: request.url,
          kind: "memory" as const,
          sha256: request.expectedSha256 ?? emptySha256,
          sizeBytes: 0,
          fromCache: false,
        };
      }),
  };
  const datasetBridge = {
    fetch: (endpoint: DataEndpoint) =>
      Effect.sync(() => {
        input.records.delegations.push({ operation: "fetch", endpoint });
      }),
    send: (endpoint: DataEndpoint) =>
      Effect.sync(() => {
        input.records.delegations.push({ operation: "send", endpoint });
      }),
  };
  const locatorFor = (env: RemoteEnvId, dataset: string): RemoteLocator => ({
    remote: input.id,
    env,
    dataset: dataset as DatasetKind,
    endpoint: `memory://${input.id}/${env}/${dataset}`,
    metadata: { token: TEST_REMOTE_SECRET },
  });

  return {
    id: input.id,
    capabilities,
    configSchema: Schema.Unknown,
    listEnvironments: () => Effect.succeed(environments),
    resolve: (_cfg, env, dataset) => {
      if (env === missingEnv) {
        return Effect.fail(new RemoteEnvNotFoundError({ message: "Unknown environment", env }));
      }
      if ((capabilities.datasets as ReadonlyArray<string>).includes(dataset) === false) {
        return Effect.fail(
          new RemoteDatasetUnsupportedError({ message: "Unsupported dataset", env, dataset }),
        );
      }
      return Effect.succeed(locatorFor(env, dataset));
    },
    fetch: (locator, opts) =>
      Effect.gen(function* () {
        input.captured.push(
          event({
            _tag: "pre-dataset-fetch",
            eventName: "pre-dataset-fetch",
            remote: input.id,
            env: locator.env,
            dataset: locator.dataset,
            timestamp: TIMESTAMP,
          } satisfies LandoEvent),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => void input.records.finalizers.push({ operation: "fetch", remote: input.id })),
        );
        yield* downloader
          .download({
            url: `https://tools.example.test/${capabilities.tool ?? "remote-cli"}.tgz`,
            destination: { kind: "memory" },
            expectedSha256: emptySha256,
            callerId: `${input.id}:tool-provision`,
            redactionTokens: [TEST_REMOTE_SECRET],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RemoteToolMissingError({
                  message: "Tool provisioning failed",
                  remote: input.id,
                  tool: capabilities.tool,
                  cause,
                }),
            ),
          );
        yield* http.stream({ url: locator.endpoint ?? `https://remote.example.test/${input.id}/fetch` }).pipe(
          Effect.mapError(
            (cause) =>
              new RemoteUnreachableError({
                message: "Remote fetch egress failed",
                remote: input.id,
                cause,
              }),
          ),
        );
        const endpoint = artifact;
        yield* datasetBridge.fetch(endpoint);
        if (opts?.expectedDigest === INTERRUPT_DIGEST) yield* Effect.never;
        input.captured.push(
          event({
            _tag: "post-dataset-fetch",
            eventName: "post-dataset-fetch",
            remote: input.id,
            env: locator.env,
            dataset: locator.dataset,
            timestamp: TIMESTAMP,
            outcome: "success",
            failureDetail: TEST_REMOTE_SECRET,
            durationMs: 1,
          } satisfies LandoEvent),
        );
        return endpoint;
      }),
    send: (locator, endpoint, opts) => {
      if (!input.push) {
        return Effect.fail(
          new RemoteDatasetUnsupportedError({
            message: "Remote source does not support push",
            remote: input.id,
            env: locator.env,
            dataset: locator.dataset,
          }),
        );
      }
      if (locator.env === protectedEnv && opts?.protectedEnvConfirmed !== true) {
        return Effect.fail(
          new RemoteProtectedEnvError({
            message: "Protected environment requires confirmation",
            remote: input.id,
            env: locator.env,
            dataset: locator.dataset,
          }),
        );
      }
      return Effect.gen(function* () {
        input.captured.push(
          event({
            _tag: "pre-dataset-send",
            eventName: "pre-dataset-send",
            remote: input.id,
            env: locator.env,
            dataset: locator.dataset,
            timestamp: TIMESTAMP,
          } satisfies LandoEvent),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => void input.records.finalizers.push({ operation: "send", remote: input.id })),
        );
        yield* downloader
          .download({
            url: `https://tools.example.test/${capabilities.tool ?? "remote-cli"}.tgz`,
            destination: { kind: "memory" },
            expectedSha256: emptySha256,
            callerId: `${input.id}:tool-provision`,
            redactionTokens: [TEST_REMOTE_SECRET],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RemoteToolMissingError({
                  message: "Tool provisioning failed",
                  remote: input.id,
                  tool: capabilities.tool,
                  cause,
                }),
            ),
          );
        yield* http
          .stream({ url: locator.endpoint ?? `https://remote.example.test/${input.id}/send` })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RemoteUnreachableError({ message: "Remote send egress failed", remote: input.id, cause }),
            ),
          );
        yield* datasetBridge.send(endpoint);
        if (opts?.expectedDigest === INTERRUPT_DIGEST) yield* Effect.never;
        input.captured.push(
          event({
            _tag: "post-dataset-send",
            eventName: "post-dataset-send",
            remote: input.id,
            env: locator.env,
            dataset: locator.dataset,
            timestamp: TIMESTAMP,
            outcome: "success",
            durationMs: 1,
          } satisfies LandoEvent),
        );
      });
    },
    test: (_cfg, env) =>
      Effect.sync(() => {
        input.records.probes.push(env === undefined ? { remote: input.id } : { remote: input.id, env });
        return { ok: true, env, message: "ready" };
      }),
  };
};

export const makeTestRemoteSource = (options: { readonly name?: string } = {}) =>
  Effect.sync((): TestRemoteSourceHandle => {
    const captured: Array<LandoEvent> = [];
    const records = { egress: [], tools: [], delegations: [], finalizers: [], probes: [] } satisfies {
      egress: Array<RemoteEgressRecord>;
      tools: Array<ToolProvisionRecord>;
      delegations: Array<DatasetDelegationRecord>;
      finalizers: Array<FinalizerRecord>;
      probes: Array<ProbeRecord>;
    };
    const id = options.name ?? "test";

    return {
      source: makeRemoteSource({ id, push: true, captured, records }),
      noPushSource: makeRemoteSource({ id: `${id}-no-push`, push: false, captured, records }),
      config: { source: id, token: TEST_REMOTE_SECRET },
      supportedEnv,
      protectedEnv,
      missingEnv,
      supportedDataset,
      unsupportedDataset,
      artifact,
      observations: {
        egressRequests: () => Effect.sync(() => [...records.egress]),
        toolProvisions: () => Effect.sync(() => [...records.tools]),
        datasetDelegations: () => Effect.sync(() => [...records.delegations]),
        finalizers: () => Effect.sync(() => [...records.finalizers]),
        probes: () => Effect.sync(() => [...records.probes]),
      },
      events: () => [...captured],
    };
  });

export const TestRemoteSource: TestRemoteSourceHandle = makeTestRemoteSource().pipe(Effect.runSync);
export const localRemoteSource: TestRemoteSourceHandle = makeTestRemoteSource({ name: "local" }).pipe(
  Effect.runSync,
);

const sameBytes = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null && left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

export const makeTestDataset = () =>
  Effect.sync((): TestDatasetHandle => {
    const expectedBytes = new TextEncoder().encode(`dataset-payload:${TEST_DATASET_SECRET}`);
    const captured: Array<LandoEvent> = [];
    const transfers: Array<DataMoverRecord> = [];
    const streams: Array<DataMoverRecord> = [];
    let appliedBytes: Uint8Array | null = null;
    const context: DatasetContext = { app, plan, service, creds: { password: TEST_DATASET_SECRET } };
    const codeTreeContext: DatasetContext = {
      app,
      plan,
      service,
      binding: { path: "." },
      creds: { password: TEST_DATASET_SECRET },
    };
    const recordOperation = (spec: DataTransferSpec): "capture" | "apply" =>
      spec.from._tag === "serviceCmd" ? "capture" : "apply";
    const recordEndpoint = (spec: DataTransferSpec): DataEndpoint =>
      spec.from._tag === "serviceCmd" ? spec.to : spec.from;
    const recordCommand = (spec: DataTransferSpec): CommandSpec | undefined => {
      if (spec.from._tag === "serviceCmd") return spec.from.command;
      if (spec.to._tag === "serviceCmd") return spec.to.command;
      return undefined;
    };
    const dataMover: DataMoverShape = {
      transfer: (spec) =>
        Effect.sync(() => {
          transfers.push({
            operation: recordOperation(spec),
            endpoint: recordEndpoint(spec),
            command: recordCommand(spec),
          });
          return { accelerated: false, sizeBytes: expectedBytes.byteLength };
        }),
      transferStream: (spec) => {
        const progress: DataTransferProgress = {
          phase: "completed",
          transferredBytes: expectedBytes.byteLength,
        };
        return Stream.sync(() => {
          streams.push({
            operation: recordOperation(spec),
            endpoint: recordEndpoint(spec),
            command: recordCommand(spec),
          });
          return progress;
        });
      },
      snapshot: (store) => Effect.succeed({ id: "remote-sync-contract-snapshot", store }),
      restore: () => Effect.void,
      listSnapshots: () => Effect.succeed([]),
      removeSnapshot: () => Effect.void,
      pruneSnapshots: () => Effect.succeed([]),
    };
    const rejectCodeTree = (ctx: DatasetContext) =>
      ctx.binding !== undefined && ctx.binding.path === "."
        ? new DatasetBindingError({
            message: "Dataset binding targets the app code tree",
            dataset: "test",
            service,
            path: ".",
          })
        : undefined;

    const dataset: DatasetShape = {
      id: "test",
      kind: supportedDataset,
      capabilities: { capture: true, apply: true, localStore: true, destructiveApply: true },
      artifactFormat: { endpoint: "hostArchive", archiveFormat: "tar", mediaType: "application/x-tar" },
      capture: (ctx) => {
        const bindingError = rejectCodeTree(ctx);
        if (bindingError !== undefined) return Effect.fail(bindingError);
        return Effect.gen(function* () {
          captured.push(
            event({
              _tag: "pre-dataset-capture",
              eventName: "pre-dataset-capture",
              remote: "test",
              env: supportedEnv,
              dataset: supportedDataset,
              timestamp: TIMESTAMP,
            } satisfies LandoEvent),
          );
          yield* dataMover
            .transfer({
              from: { _tag: "serviceCmd", app, service, command: ["dump"] },
              to: artifact,
            })
            .pipe(
              Effect.mapError(
                (cause) => new DatasetCaptureError({ message: "DataMover capture transfer failed", cause }),
              ),
            );
          yield* dataMover
            .transferStream({
              from: { _tag: "serviceCmd", app, service, command: ["dump"] },
              to: artifact,
            })
            .pipe(
              Stream.runCollect,
              Effect.mapError(
                (cause) => new DatasetCaptureError({ message: "DataMover capture stream failed", cause }),
              ),
            );
          captured.push(
            event({
              _tag: "post-dataset-capture",
              eventName: "post-dataset-capture",
              remote: "test",
              env: supportedEnv,
              dataset: supportedDataset,
              timestamp: TIMESTAMP,
              outcome: "success",
              failureDetail: TEST_DATASET_SECRET,
              durationMs: 1,
            } satisfies LandoEvent),
          );
          return artifact;
        });
      },
      apply: (ctx, endpoint) => {
        const bindingError = rejectCodeTree(ctx);
        if (bindingError !== undefined) return Effect.fail(bindingError);
        if (endpoint._tag !== artifact._tag) {
          return Effect.fail(new DatasetApplyError({ message: "Unsupported artifact", dataset: "test" }));
        }
        return Effect.gen(function* () {
          captured.push(
            event({
              _tag: "pre-dataset-apply",
              eventName: "pre-dataset-apply",
              remote: "test",
              env: supportedEnv,
              dataset: supportedDataset,
              timestamp: TIMESTAMP,
            } satisfies LandoEvent),
          );
          yield* dataMover
            .transfer({
              from: endpoint,
              to: { _tag: "serviceCmd", app, service, command: ["restore"] },
            })
            .pipe(
              Effect.mapError(
                (cause) => new DatasetApplyError({ message: "DataMover apply transfer failed", cause }),
              ),
            );
          const changed = !sameBytes(appliedBytes, expectedBytes);
          appliedBytes = new Uint8Array(expectedBytes);
          captured.push(
            event({
              _tag: "post-dataset-apply",
              eventName: "post-dataset-apply",
              remote: "test",
              env: supportedEnv,
              dataset: supportedDataset,
              timestamp: TIMESTAMP,
              outcome: "success",
              durationMs: 1,
            } satisfies LandoEvent),
          );
          return { changed, localStore, summary: "applied test dataset" };
        });
      },
      localStore: () => Effect.succeed(localStore),
    };

    return {
      dataset,
      context,
      codeTreeContext,
      expectedBytes,
      observations: {
        dataMoverTransfers: () => Effect.sync(() => [...transfers]),
        dataMoverStreams: () => Effect.sync(() => [...streams]),
      },
      events: () => [...captured],
      readAppliedBytes: () => (appliedBytes === null ? null : new Uint8Array(appliedBytes)),
    };
  });

export const TestDataset: TestDatasetHandle = makeTestDataset().pipe(Effect.runSync);
