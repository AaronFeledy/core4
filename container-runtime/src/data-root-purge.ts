import { mapFailures } from "@lando/sdk/command-result";
import {
  LANDO_DATA_ROOT_LABEL,
  LANDO_NETWORK_ROLE_LABEL,
  LANDO_SHARED_CROSS_APP_NETWORK,
  ProviderId,
  landoSharedCrossAppNetworkName,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { removeRuntimeContainer } from "./container-removal.ts";
import type { EngineHttpApi, EngineHttpRequest, ProviderErrorContext } from "./engine-api.ts";
import { isSuccessStatus } from "./engine-api.ts";
import { apiResponseFailure, missingApi, missingRequest } from "./engine-errors.ts";
import { BUILT_ARTIFACT_PREFIX, BUILT_ARTIFACT_STORE_LABEL } from "./image-build.ts";
import { listContainerArtifacts, normalizeImageRef } from "./image-list.ts";
import { removeContainerArtifact } from "./image-remove.ts";
import { APP_LABEL, APP_ROOT_LABEL, PROVIDER_LABEL, VOLUME_INSTANCE_LABEL } from "./labels.ts";
import {
  coherentContainerOwnership,
  coherentPrivateNetworkOwnership,
  decodeNativeObservation,
  ownsSharedCrossAppNetwork,
} from "./native-ownership.ts";
import { redactString, redactorFor } from "./redact.ts";
import { VOLUME_OWNER_LABEL, VOLUME_SELECTOR_LABEL, coherentVolumeOwnership } from "./volume-ownership.ts";

const operation = "uninstall.purge";
const kinds = ["container", "network", "volume"] as const;
type Kind = (typeof kinds)[number];
type Labels = Readonly<Record<string, string>>;
type Resource = {
  readonly kind: Kind;
  readonly nativeName: string;
  readonly id: string;
  readonly labels: Labels;
};

export type DataRootPurgeOptions = {
  readonly endpoint: string;
  readonly dataRoot: string;
  readonly buildStore: string;
  readonly owns?: (resource: Resource) => boolean;
};

const lists = {
  container: "/containers/json?all=true&",
  network: "/networks?",
  volume: "/volumes?",
} as const;
const landoLabels = {
  container: [LANDO_DATA_ROOT_LABEL, APP_LABEL, "com.lando.app"],
  network: [LANDO_DATA_ROOT_LABEL, APP_LABEL, "com.lando.app", "dev.lando.network", "dev.lando.owner"],
  volume: [
    LANDO_DATA_ROOT_LABEL,
    APP_LABEL,
    "com.lando.app",
    VOLUME_OWNER_LABEL,
    VOLUME_SELECTOR_LABEL,
    "dev.lando.volume",
  ],
} as const;
const filters = (value: Readonly<Record<string, readonly string[]>>) =>
  encodeURIComponent(JSON.stringify(value));
const Ids = Schema.fromJsonString(Schema.Array(Schema.Struct({ Id: Schema.NonEmptyString })));
const Volumes = Schema.fromJsonString(
  Schema.Struct({
    Volumes: Schema.NullOr(Schema.Array(Schema.Struct({ Name: Schema.NonEmptyString }))),
  }),
);
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
  const endpoint = redactString(options.endpoint, redactorFor(ctx));
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
  const ownedFilter = { label: [`${LANDO_DATA_ROOT_LABEL}=${options.dataRoot}`] };
  const owns =
    options.owns ?? ((resource: Resource) => resource.labels[LANDO_DATA_ROOT_LABEL] === options.dataRoot);
  const list = Effect.fnUntraced(function* (kind: Kind, filter = ownedFilter) {
    const response = yield* read({ method: "GET", path: `${lists[kind]}filters=${filters(filter)}` });
    if (kind === "volume") {
      const body = yield* Schema.decodeUnknownEffect(Volumes)(response.body).pipe(
        mapFailures(() => invalid("Invalid volume list.")),
      );
      return [...new Set((body.Volumes ?? []).map(({ Name }) => Name))];
    }
    const body = yield* Schema.decodeUnknownEffect(Ids)(response.body).pipe(
      mapFailures(() => invalid(`Invalid ${kind} list.`)),
    );
    return [...new Set(body.map(({ Id }) => Id))];
  });
  const listOtherLandoResources = Effect.fnUntraced(function* (kind: Kind, selected: readonly string[]) {
    const others = new Set<string>();
    const scoped = new Set(selected);
    for (const label of landoLabels[kind]) {
      const listed = yield* list(kind, { label: [label] }).pipe(Effect.result);
      if (Result.isSuccess(listed)) for (const id of listed.success) if (!scoped.has(id)) others.add(id);
    }
    return [...others];
  });
  const inspect = Effect.fnUntraced(function* (kind: Kind, ref: string) {
    const path = `/${kind}s/${encodeURIComponent(ref)}${kind === "container" ? "/json" : ""}` as const;
    const response = yield* read({ method: "GET", path }, true);
    if (response.status === 404) return undefined;
    const observed = decodeNativeObservation(response.body);
    const name = observed?.Name ?? observed?.name;
    const id = kind === "volume" ? name : (observed?.Id ?? observed?.ID ?? observed?.id);
    if (!observed || id !== ref) return yield* invalid(`Cannot verify exact ${kind} identity ${ref}.`);
    const labels = observed.Config?.Labels ?? observed.Labels ?? observed.labels ?? {};
    return {
      kind,
      nativeName: name ?? ref,
      id,
      labels,
      attached: Object.keys(observed.Containers ?? {}).length > 0,
    };
  });
  const shared = (resource: Resource) =>
    resource.nativeName === landoSharedCrossAppNetworkName(options.dataRoot);
  const coherent = (resource: Resource) => {
    const { labels } = resource;
    // A Docker-compatible endpoint can expose objects realized through either host provider.
    const provider = labels[PROVIDER_LABEL] ?? ctx.providerId;
    if (provider !== ctx.providerId && provider !== "docker" && provider !== "podman" && provider !== "lando")
      return false;
    switch (resource.kind) {
      case "container":
        return coherentContainerOwnership(labels, provider);
      case "network":
        if (shared(resource)) return ownsSharedCrossAppNetwork(options.dataRoot, resource.nativeName, labels);
        return (
          resource.nativeName !== LANDO_SHARED_CROSS_APP_NETWORK &&
          labels[LANDO_NETWORK_ROLE_LABEL] === undefined &&
          coherentPrivateNetworkOwnership(labels, provider)
        );
      case "volume":
        return coherentVolumeOwnership(labels, provider);
    }
  };
  const imageSelector = { labels: { [BUILT_ARTIFACT_STORE_LABEL]: options.buildStore } };
  const images = listContainerArtifacts(boundedApi, imageSelector, ctx);
  const syncMarker = (resource: Resource) => resource.labels["dev.lando.sync.kind"];
  const counts = { container: 0, network: 0, volume: 0, image: 0 };
  const apps = new Map<string, { readonly appId: string; readonly appRoot: string }>();
  let syncPresent = false;
  for (const kind of kinds) {
    const selected = yield* list(kind);
    const others = options.owns === undefined ? [] : yield* listOtherLandoResources(kind, selected);
    for (const ref of [...selected, ...others]) {
      const found = yield* inspect(kind, ref);
      if (!found || !owns(found)) continue;
      if (syncMarker(found) !== undefined) syncPresent = true;
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
    for (const kind of kinds) {
      yield* record(
        `${kind} discovery`,
        Effect.gen(function* () {
          const candidates = yield* list(kind);
          const outside = yield* listOtherLandoResources(kind, candidates);
          if (options.owns === undefined) outsideScope += outside.length;
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
          if (options.owns !== undefined) {
            for (const ref of outside) yield* record(`${kind} ${ref}`, remove(ref));
          }
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
