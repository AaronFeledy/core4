import { mapFailures } from "@lando/sdk/command-result";
import {
  LANDO_DATA_ROOT_LABEL,
  LANDO_NETWORK_ROLE_LABEL,
  LANDO_SHARED_CROSS_APP_NETWORK,
  landoSharedCrossAppNetworkName,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import {
  type DataRootOwnershipContext,
  type DataRootResource,
  decideDataRootOwnership,
} from "./data-root-ownership.ts";
import type { EngineHttpApi } from "./engine-api.ts";
import type { missingRequest } from "./engine-errors.ts";
import { APP_LABEL, PROVIDER_LABEL, VOLUME_INSTANCE_LABEL } from "./labels.ts";
import {
  coherentContainerOwnership,
  coherentPrivateNetworkOwnership,
  decodeNativeObservation,
  ownsSharedCrossAppNetwork,
} from "./native-ownership.ts";
import { VOLUME_OWNER_LABEL, VOLUME_SELECTOR_LABEL, coherentVolumeOwnership } from "./volume-ownership.ts";

export const purgeKinds = ["container", "network", "volume"] as const;
type Kind = (typeof purgeKinds)[number];
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
const Ids = Schema.fromJsonString(Schema.Array(Schema.Struct({ Id: Schema.NonEmptyString })));
const Volumes = Schema.fromJsonString(
  Schema.Struct({ Volumes: Schema.NullOr(Schema.Array(Schema.Struct({ Name: Schema.NonEmptyString }))) }),
);

type CandidateRead = (
  input: Parameters<NonNullable<EngineHttpApi["request"]>>[0],
  absentOk?: boolean,
) => ReturnType<NonNullable<EngineHttpApi["request"]>>;

export const makePurgeCandidates = (
  ownership: DataRootOwnershipContext,
  providerId: string,
  engine: {
    readonly read: CandidateRead;
    readonly invalid: (message: string) => ReturnType<typeof missingRequest>;
  },
) => {
  const { read, invalid } = engine;
  const { dataRoot, receipts } = ownership;
  const receiptRefs = { container: new Set<string>(), network: new Set<string>(), volume: new Set<string>() };
  for (const receipt of receipts)
    receiptRefs[receipt.kind].add(receipt.kind === "volume" ? receipt.nativeName : receipt.nativeId);
  const owns = (resource: DataRootResource) => decideDataRootOwnership(resource, ownership) === "owned";
  const list = Effect.fnUntraced(function* (kind: Kind, filter: Readonly<Record<string, readonly string[]>>) {
    const filters = encodeURIComponent(JSON.stringify(filter));
    const response = yield* read({ method: "GET", path: `${lists[kind]}filters=${filters}` });
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
  const listCandidates = (kind: Kind) =>
    list(kind, { label: [`${LANDO_DATA_ROOT_LABEL}=${dataRoot}`] }).pipe(
      Effect.map((selected) => new Set([...selected, ...receiptRefs[kind]])),
    );
  const countOutsideScope = Effect.fnUntraced(function* (kind: Kind, candidates: ReadonlySet<string>) {
    const others = new Set<string>();
    for (const label of landoLabels[kind]) {
      const listed = yield* list(kind, { label: [label] }).pipe(Effect.result);
      if (Result.isSuccess(listed)) for (const id of listed.success) if (!candidates.has(id)) others.add(id);
    }
    return others.size;
  });
  const inspect = Effect.fnUntraced(function* (kind: Kind, ref: string) {
    const path = `/${kind}s/${encodeURIComponent(ref)}${kind === "container" ? "/json" : ""}` as const;
    const response = yield* read({ method: "GET", path }, true);
    if (response.status === 404) return undefined;
    const observed = decodeNativeObservation(response.body);
    const name = observed?.Name ?? observed?.name;
    const id = kind === "volume" ? name : (observed?.Id ?? observed?.ID ?? observed?.id);
    if (!observed || id !== ref) return yield* invalid(`Cannot verify exact ${kind} identity ${ref}.`);
    const labels =
      (kind === "container" ? observed.Config?.Labels : undefined) ??
      observed.Labels ??
      observed.labels ??
      {};
    return {
      kind,
      nativeName: (kind === "container" ? name?.replace(/^\//u, "") : name) ?? "",
      nativeId: id,
      volumeInstance: labels[VOLUME_INSTANCE_LABEL],
      labels,
      attached: Object.keys(observed.Containers ?? {}).length > 0,
    };
  });
  type Resource = NonNullable<Effect.Success<ReturnType<typeof inspect>>>;
  const shared = (resource: Resource) => resource.nativeName === landoSharedCrossAppNetworkName(dataRoot);
  const coherent = (resource: Resource) => {
    const { labels } = resource;
    // A Docker-compatible endpoint can expose objects realized through either host provider.
    const provider = labels[PROVIDER_LABEL] ?? providerId;
    if (provider !== providerId && provider !== "docker" && provider !== "podman" && provider !== "lando")
      return false;
    switch (resource.kind) {
      case "container":
        return coherentContainerOwnership(labels, provider);
      case "network":
        if (shared(resource)) return ownsSharedCrossAppNetwork(dataRoot, resource.nativeName, labels);
        return (
          resource.nativeName !== LANDO_SHARED_CROSS_APP_NETWORK &&
          labels[LANDO_NETWORK_ROLE_LABEL] === undefined &&
          coherentPrivateNetworkOwnership(labels, provider)
        );
      case "volume":
        return coherentVolumeOwnership(labels, provider);
      default:
        return resource.kind satisfies never;
    }
  };
  return { list, listCandidates, countOutsideScope, inspect, owns, shared, coherent };
};
