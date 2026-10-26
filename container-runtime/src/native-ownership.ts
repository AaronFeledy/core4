import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  LANDO_SHARED_CROSS_APP_NETWORK,
  appIdentityKey,
  landoSharedNetworkName,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "./labels.ts";
import { isOwnershipRoot } from "./ownership-root.ts";

const Labels = Schema.Record(Schema.String, Schema.String);
const Observation = Schema.Struct({
  Id: Schema.optionalKey(Schema.String),
  ID: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  Name: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  Labels: Schema.optionalKey(Schema.NullOr(Labels)),
  labels: Schema.optionalKey(Schema.NullOr(Labels)),
  Config: Schema.optionalKey(Schema.Struct({ Labels: Schema.optionalKey(Labels) })),
});
export type NativeObservation = typeof Observation.Type;
export const Observations = Schema.fromJsonString(Schema.Union([Observation, Schema.Array(Observation)]));

export const decodeNativeObservation = (body: string): NativeObservation | undefined => {
  const decoded = Schema.decodeUnknownOption(Observations)(body);
  if (Option.isNone(decoded)) return undefined;
  if (Schema.is(Observation)(decoded.value)) return decoded.value;
  return decoded.value.length === 1 ? decoded.value[0] : undefined;
};

export const coherentContainerOwnership = (
  labels: Readonly<Record<string, string>>,
  providerId: string,
): boolean => {
  const app = labels[APP_LABEL];
  const legacy = labels["com.lando.app"];
  if (app === undefined) {
    return !!legacy && !Object.keys(labels).some((key) => key.startsWith("dev.lando."));
  }
  const root = labels[APP_ROOT_LABEL];
  return (
    !!app &&
    !!root &&
    isOwnershipRoot(root) &&
    !!labels[SERVICE_LABEL] &&
    (legacy === undefined || legacy === app) &&
    (labels["dev.lando.provider"] === undefined || labels["dev.lando.provider"] === providerId) &&
    (labels["dev.lando.owner"] === undefined || labels["dev.lando.owner"] === appIdentityKey("owner", root))
  );
};

export const coherentPrivateNetworkOwnership = (
  labels: Readonly<Record<string, string>>,
  providerId: string,
): boolean => {
  const appId = labels[APP_LABEL];
  const appRoot = labels[APP_ROOT_LABEL];
  if (!appId || !appRoot || !isOwnershipRoot(appRoot)) return false;
  return (
    networkLabelsDecision(
      labels,
      privateNetworkLabels({
        appId,
        appRoot,
        ownerKey: appIdentityKey("owner", appRoot),
        providerId,
      }),
    ) === "owned"
  );
};

export const privateNetworkLabels = (resource: {
  readonly appId: string;
  readonly appRoot: string;
  readonly ownerKey: string;
  readonly providerId: string;
}) => ({
  [APP_LABEL]: resource.appId,
  [APP_ROOT_LABEL]: resource.appRoot,
  "dev.lando.owner": resource.ownerKey,
  "dev.lando.provider": resource.providerId,
});

export const containerOwnershipLabels = (plan: AppPlan, service: string) => ({
  [APP_LABEL]: plan.id,
  [APP_ROOT_LABEL]: planAppIdentity(plan).appRoot,
  [SERVICE_LABEL]: service,
});

export const networkOwnershipLabels = (plan: AppPlan) =>
  privateNetworkLabels({ ...planAppIdentity(plan), appId: plan.id, providerId: plan.provider });

/** Legacy labels require separate exact-name proof because native lookup also accepts ID prefixes. */
export const networkLabelsDecision = (
  labels: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
): "owned" | "legacy" | "foreign" => {
  if (labels === undefined || Object.keys(labels).length === 0) return "legacy";
  return Object.keys(labels).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => labels[key] === value)
    ? "owned"
    : "foreign";
};

export const isSharedNetwork = (plan: Pick<AppPlan, "networking">, name: string): boolean =>
  name === LANDO_SHARED_CROSS_APP_NETWORK || name === landoSharedNetworkName(plan);

const refused = (ctx: ProviderErrorContext) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "resource-ownership",
    message: "Native resource ownership labels or identity could not be verified. No mutation is authorized.",
    remediation:
      "Inspect the conflicting native resource and restore its verified Lando ownership or move it out of the planned name before retrying. Unlabeled resources cannot be adopted.",
  });

export const verifiedNativeId = Effect.fnUntraced(function* (
  body: string,
  expected: Readonly<Record<string, string>>,
  ctx: ProviderErrorContext,
) {
  const decoded = Schema.decodeUnknownOption(Observations)(body);
  if (Option.isNone(decoded)) return yield* Effect.fail(refused(ctx));
  const observed = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
  if (observed === undefined) return yield* Effect.fail(refused(ctx));
  const labels = observed.Config?.Labels ?? observed.Labels ?? observed.labels ?? {};
  const id = observed.Id ?? observed.ID ?? observed.id;
  if (!id || Object.entries(expected).some(([key, value]) => labels[key] !== value))
    return yield* Effect.fail(refused(ctx));
  return id;
});

export const inspectOwnedNativeId = Effect.fn("NativeOwnership.inspect")(function* (
  api: EngineHttpApi,
  target: (
    | { readonly kind: "container" }
    | {
        readonly kind: "network";
        readonly legacy: "accept" | "reject";
      }
  ) & {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  },
  ctx: ProviderErrorContext,
) {
  if (api.request === undefined) return yield* Effect.fail(refused(ctx));
  let path: `/containers/${string}/json` | `/networks/${string}`;
  switch (target.kind) {
    case "container":
      path = `/containers/${encodeURIComponent(target.name)}/json`;
      break;
    case "network":
      path = `/networks/${encodeURIComponent(target.name)}`;
      break;
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
  const response = yield* api.request({
    method: "GET",
    path,
  });
  if (response.status === 404) return undefined;
  if (response.status !== 200) return yield* Effect.fail(refused(ctx));
  switch (target.kind) {
    case "container":
      return yield* verifiedNativeId(response.body, target.labels, ctx);
    case "network": {
      const decoded = Schema.decodeUnknownOption(Observations)(response.body);
      if (Option.isNone(decoded)) return yield* Effect.fail(refused(ctx));
      const observed = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
      const id = observed?.Id ?? observed?.ID ?? observed?.id;
      const decision = networkLabelsDecision(
        observed?.Labels ?? observed?.labels ?? undefined,
        target.labels,
      );
      if (
        !id ||
        decision === "foreign" ||
        (decision === "legacy" &&
          (target.legacy === "reject" || (observed?.Name ?? observed?.name) !== target.name))
      )
        return yield* Effect.fail(refused(ctx));
      return id;
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
});
