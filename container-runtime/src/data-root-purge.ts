import { mapFailures } from "@lando/sdk/command-result";
import type { ProviderPurgePreflight } from "@lando/sdk/plugins";
import { type EngineIdentity, ProviderId } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { removeRuntimeContainer } from "./container-removal.ts";
import { makePurgeCandidates, purgeKinds } from "./data-root-purge-candidates.ts";
import type {
  EngineApiClient,
  EngineHttpApi,
  EngineHttpRequest,
  ProviderErrorContext,
} from "./engine-api.ts";
import { isSuccessStatus } from "./engine-api.ts";
import { apiResponseFailure, missingApi, missingRequest } from "./engine-errors.ts";
import { engineEndpointDisplay } from "./engine-identity.ts";
import { BUILT_ARTIFACT_PREFIX, BUILT_ARTIFACT_STORE_LABEL } from "./image-build.ts";
import { listContainerArtifacts, normalizeImageRef } from "./image-list.ts";
import { removeContainerArtifact } from "./image-remove.ts";
import { APP_LABEL, APP_ROOT_LABEL, VOLUME_INSTANCE_LABEL } from "./labels.ts";
import { guardPurgePlacement } from "./purge-placement.ts";
import { redactString, redactorFor } from "./redact.ts";
import { readDataRootAdoptionReceipts } from "./resource-ownership-records.ts";

const operation = "uninstall.purge";
export type DataRootPurgeOptions = {
  readonly endpoint: string;
  readonly dataRoot: string;
  readonly buildStore: string;
  readonly pluginId: string;
};

const Image = Schema.fromJsonString(
  Schema.Struct({
    Id: Schema.NonEmptyString,
    RepoTags: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    Config: Schema.Struct({
      Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    }),
  }),
);
const bareImageId = (id: string) => id.replace(/^sha256:/u, "");

export const preflightDataRootPurge = Effect.fn("DataRootPurge.preflight")(function* (
  api: EngineHttpApi,
  ctx: ProviderErrorContext,
  options: DataRootPurgeOptions,
) {
  const endpoint = redactString(engineEndpointDisplay(options.endpoint), redactorFor(ctx));
  const ownership = yield* readDataRootAdoptionReceipts(ctx.providerId, options);
  const send = api.request;
  if (!send) return yield* missingApi(ctx, operation);
  const probe = yield* send({ method: "GET", path: "/_ping" }).pipe(
    Effect.timeout("2 seconds"),
    Effect.result,
  );
  if (Result.isFailure(probe) || !isSuccessStatus(probe.success.status)) {
    const reason = Result.isFailure(probe) ? probe.failure.message : `HTTP ${probe.success.status}`;
    return { kind: "skipped" as const, endpoint, reason };
  }

  const invalid = (message: string) => missingRequest(ctx, operation, message);
  const request = (input: EngineHttpRequest) =>
    send(input).pipe(
      Effect.timeout("60 seconds"),
      mapFailures((error) =>
        error._tag === "TimeoutError" ? invalid(`Engine request timed out: ${input.path}`) : error,
      ),
    );
  const boundedApi = { request };
  const read = Effect.fnUntraced(function* (input: EngineHttpRequest, absentOk = false) {
    const response = yield* request(input);
    if (!isSuccessStatus(response.status) && !(absentOk && response.status === 404)) {
      return yield* apiResponseFailure(
        ctx,
        operation,
        response,
        `Engine request returned HTTP ${response.status}: ${input.path}`,
      );
    }
    return response;
  });
  const { list, listCandidates, countOutsideScope, inspect, owns, shared, coherent } = makePurgeCandidates(
    ownership,
    ctx.providerId,
    { read, invalid },
  );
  const imageSelector = { labels: { [BUILT_ARTIFACT_STORE_LABEL]: options.buildStore } };
  const images = listContainerArtifacts(boundedApi, imageSelector, ctx);
  const counts = { container: 0, network: 0, volume: 0, image: 0 };
  const apps = new Map<string, { readonly appId: string; readonly appRoot: string }>();
  let syncPresent = false;
  for (const kind of purgeKinds) {
    for (const ref of yield* listCandidates(kind)) {
      const found = yield* inspect(kind, ref);
      if (!found || !owns(found)) continue;
      if (found.labels["dev.lando.sync.kind"] !== undefined) syncPresent = true;
      if (!coherent(found)) continue;
      counts[kind]++;
      const appId = found.labels[APP_LABEL];
      const appRoot = found.labels[APP_ROOT_LABEL];
      if (kind === "container" && appId && appRoot) apps.set(appRoot, { appId, appRoot });
    }
  }
  counts.image = (yield* images).length;

  const sweep = Effect.fn("DataRootPurge.sweep")(function* () {
    const removed: string[] = [];
    const retained: string[] = [];
    const failed: string[] = [];
    let outsideScope = 0;
    const record = Effect.fnUntraced(function* (
      resource: string,
      action: Effect.Effect<void, { readonly message: string }>,
    ) {
      const result = yield* Effect.result(action);
      if (Result.isFailure(result)) failed.push(`${resource}: ${result.failure.message}`);
    });
    for (const kind of purgeKinds) {
      yield* record(
        `${kind} discovery`,
        Effect.gen(function* () {
          const candidates = yield* listCandidates(kind);
          outsideScope += yield* countOutsideScope(kind, candidates);
          const bridges: string[] = [];
          const remove = Effect.fnUntraced(function* (ref: string, bridge = false) {
            const resource = `${kind} ${ref}`;
            const found = yield* inspect(kind, ref);
            if (!found) return;
            if (!owns(found)) {
              outsideScope++;
              return;
            }
            if (!coherent(found)) {
              retained.push(`${resource}: structural ownership unverified`);
              return;
            }
            if (kind === "network" && shared(found) && !bridge) {
              bridges.push(ref);
              return;
            }
            if (bridge) {
              const attached = yield* list("container", { network: [ref] });
              if (!shared(found) || found.attached || attached.length > 0) {
                retained.push(`${resource}: shared network changed or has attached endpoints`);
                return;
              }
            }
            if (kind === "container") {
              const stopped = yield* request({
                method: "POST",
                path: `/containers/${encodeURIComponent(ref)}/stop?t=10`,
              });
              if (stopped.status === 404) return;
              if (!isSuccessStatus(stopped.status) && stopped.status !== 304) {
                return yield* apiResponseFailure(ctx, operation, stopped, `Cannot stop ${resource}.`);
              }
              if (yield* removeRuntimeContainer(boundedApi, ref, { ...ctx, operation }))
                removed.push(resource);
              return;
            }
            if (kind === "volume") {
              const fresh = yield* inspect(kind, ref);
              if (!fresh) return;
              if (
                !owns(fresh) ||
                !coherent(fresh) ||
                fresh.labels[VOLUME_INSTANCE_LABEL] !== found.labels[VOLUME_INSTANCE_LABEL] ||
                Object.entries(found.labels).some(([key, value]) => fresh.labels[key] !== value)
              ) {
                retained.push(`${resource}: volume generation or ownership changed`);
                return;
              }
            }
            const deleted = yield* read(
              { method: "DELETE", path: `/${kind}s/${encodeURIComponent(ref)}` },
              true,
            );
            if (deleted.status !== 404) removed.push(resource);
          });
          for (const ref of candidates) yield* record(`${kind} ${ref}`, remove(ref));
          for (const ref of bridges) yield* record(`${kind} ${ref}`, remove(ref, true));
        }),
      );
    }
    yield* record(
      "image discovery",
      Effect.gen(function* () {
        const prefix = `${BUILT_ARTIFACT_PREFIX}${options.buildStore}-`;
        const inspectImage = Effect.fnUntraced(function* (ref: string) {
          const response = yield* read(
            { method: "GET", path: `/images/${encodeURIComponent(ref)}/json` },
            true,
          );
          if (response.status === 404) return undefined;
          return yield* Schema.decodeUnknownEffect(Image)(response.body).pipe(
            mapFailures(() => invalid(`Invalid image inspection for ${ref}.`)),
          );
        });
        for (const { id } of yield* images)
          yield* record(
            `image ${id}`,
            Effect.gen(function* () {
              const image = yield* inspectImage(id);
              if (!image) return;
              const tags = (image.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>");
              if (
                bareImageId(image.Id) !== bareImageId(id) ||
                image.Config.Labels?.[BUILT_ARTIFACT_STORE_LABEL] !== options.buildStore
              ) {
                retained.push(`image ${id}: build-store ownership changed`);
                return;
              }
              if (tags.some((tag) => !normalizeImageRef(tag).startsWith(prefix))) {
                retained.push(`image ${id}: foreign tags`);
                return;
              }
              if ((yield* list("container", { ancestor: [id] })).length > 0) {
                retained.push(`image ${id}: in use`);
                return;
              }
              for (const ref of tags.length === 0 ? [id] : tags) {
                const fresh = yield* inspectImage(ref);
                if (!fresh) continue;
                if (
                  bareImageId(fresh.Id) !== bareImageId(id) ||
                  fresh.Config.Labels?.[BUILT_ARTIFACT_STORE_LABEL] !== options.buildStore ||
                  (fresh.RepoTags ?? []).some(
                    (tag) =>
                      tag !== "<none>:<none>" && (!normalizeImageRef(tag).startsWith(prefix) || ref === id),
                  )
                ) {
                  retained.push(`image ${ref}: identity or tags changed`);
                  break;
                }
                const result = yield* removeContainerArtifact(
                  boundedApi,
                  { providerId: ProviderId.make(ctx.providerId), ref, pruneParents: false },
                  ctx,
                );
                switch (result.kind) {
                  case "removed":
                    removed.push(`image ${ref}`);
                    break;
                  case "in-use":
                    retained.push(`image ${ref}: ${result.reason}`);
                    break;
                  case "absent":
                    break;
                }
              }
            }),
          );
      }),
    );
    return { endpoint, removed, retained, failed, outsideScope };
  });
  return { kind: "reachable" as const, endpoint, counts, apps: [...apps.values()], syncPresent, sweep };
});

export const preflightRecordedPurge = Effect.fn("DataRootPurge.preflightRecorded")(function* (
  ctx: ProviderErrorContext,
  input: Omit<DataRootPurgeOptions, "endpoint">,
  inventory: Parameters<typeof guardPurgePlacement>[2],
  connection:
    | Extract<ProviderPurgePreflight, { kind: "skipped" }>
    | {
        readonly api: EngineApiClient;
        readonly endpoint: string;
        readonly identify: (info: unknown, endpoint: string) => EngineIdentity | undefined;
      },
) {
  if ("kind" in connection) return yield* guardPurgePlacement(ctx.providerId, input, inventory, connection);
  const { api, endpoint, identify } = connection;
  const found = yield* preflightDataRootPurge(api, ctx, { ...input, endpoint });
  const current = api.info.pipe(
    Effect.timeout("2 seconds"),
    Effect.map((info) => identify(info, endpoint)),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  return yield* guardPurgePlacement(ctx.providerId, input, inventory, found, current);
});
