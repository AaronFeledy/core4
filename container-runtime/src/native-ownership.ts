import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  LANDO_DATA_ROOT_LABEL,
  LANDO_SHARED_CROSS_APP_NETWORK,
  appIdentityKey,
  landoSharedNetworkName,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import { dataRootLabels, matchesDataRoot } from "./data-root-labels.ts";
import { type AdoptionReceipt, dataRootRefusal, decideDataRootOwnership } from "./data-root-ownership.ts";

export { matchesDataRoot, ownsSharedCrossAppNetwork } from "./data-root-labels.ts";

import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  SCRATCH_ID_LABEL,
  SCRATCH_LABEL,
  SERVICE_LABEL,
  scratchLabelsForPlan,
} from "./labels.ts";
import { isOwnershipRoot } from "./ownership-root.ts";
import { serviceContainerOwnershipProblem } from "./service-container-ownership.ts";

export {
  type ServiceContainerIdentity,
  serviceContainerOwnershipLabels,
  serviceContainerOwnershipProblem,
} from "./service-container-ownership.ts";

const Labels = Schema.Record(Schema.String, Schema.String);
const Observation = Schema.Struct({
  Id: Schema.optionalKey(Schema.String),
  ID: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  Name: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  Labels: Schema.optionalKey(Schema.NullOr(Labels)),
  labels: Schema.optionalKey(Schema.NullOr(Labels)),
  Containers: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
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
  if (app === undefined) return !!legacy && !Object.keys(labels).some((key) => key.startsWith("dev.lando."));
  return (
    serviceContainerOwnershipProblem(labels, {
      app,
      appRoot: labels[APP_ROOT_LABEL] ?? "",
      dataRoot: labels[LANDO_DATA_ROOT_LABEL],
      service: labels[SERVICE_LABEL] ?? "",
      providerId,
    }) === undefined
  );
};

export const isRecordedAppPlan = (plan: AppPlan, recorded: AppPlan | undefined): recorded is AppPlan =>
  recorded !== undefined &&
  recorded.id === plan.id &&
  recorded.provider === plan.provider &&
  planAppIdentity(recorded).appRoot === planAppIdentity(plan).appRoot &&
  matchesDataRoot(recorded.identity?.dataRoot, plan.identity?.dataRoot, true);

/** Authorizes a planned service-container mutation from native labels plus its observed identity. */
export const ownsServiceContainer = (
  plan: AppPlan,
  observation: {
    readonly containerId?: string;
    readonly service: string;
    readonly labels?: Readonly<Record<string, string>>;
  },
  recorded = false,
): boolean => {
  const labels = observation.labels;
  if (labels === undefined || !observation.containerId) return false;
  const owner = labels[LANDO_DATA_ROOT_LABEL];
  if (!matchesDataRoot(owner, plan.identity?.dataRoot, recorded)) return false;
  if (
    serviceContainerOwnershipProblem(labels, {
      app: plan.id,
      appRoot: planAppIdentity(plan).appRoot,
      service: observation.service,
      providerId: plan.provider,
      dataRoot: owner,
    }) !== undefined
  )
    return false;
  const scratch = scratchLabelsForPlan(plan);
  return (
    labels[SCRATCH_LABEL] === scratch[SCRATCH_LABEL] && labels[SCRATCH_ID_LABEL] === scratch[SCRATCH_ID_LABEL]
  );
};

export const coherentPrivateNetworkOwnership = (
  labels: Readonly<Record<string, string>>,
  providerId: string,
): boolean => {
  const appId = labels[APP_LABEL];
  const appRoot = labels[APP_ROOT_LABEL];
  if (!appId || !appRoot || !isOwnershipRoot(appRoot)) return false;
  const scratch = labels[SCRATCH_LABEL];
  const scratchId = labels[SCRATCH_ID_LABEL];
  if ((scratch !== undefined || scratchId !== undefined) && (scratch !== "TRUE" || scratchId !== appId))
    return false;
  return (
    networkLabelsDecision(
      labels,
      privateNetworkLabels({
        appId,
        appRoot,
        dataRoot: labels[LANDO_DATA_ROOT_LABEL],
        ownerKey: appIdentityKey("owner", appRoot),
        providerId,
        ...(scratch === "TRUE" ? { scratchId: appId } : {}),
      }),
    ) === "owned"
  );
};

export const privateNetworkLabels = (resource: {
  readonly appId: string;
  readonly appRoot: string;
  readonly dataRoot?: string | undefined;
  readonly ownerKey: string;
  readonly providerId: string;
  readonly scratchId?: string;
}) => ({
  [APP_LABEL]: resource.appId,
  [APP_ROOT_LABEL]: resource.appRoot,
  ...dataRootLabels(resource.dataRoot),
  "dev.lando.owner": resource.ownerKey,
  "dev.lando.provider": resource.providerId,
  ...(resource.scratchId === undefined
    ? {}
    : { [SCRATCH_LABEL]: "TRUE", [SCRATCH_ID_LABEL]: resource.scratchId }),
});

export const containerOwnershipLabels = (plan: AppPlan, service: string) => ({
  [APP_LABEL]: plan.id,
  [APP_ROOT_LABEL]: planAppIdentity(plan).appRoot,
  [SERVICE_LABEL]: service,
  ...dataRootLabels(plan.identity?.dataRoot),
  ...scratchLabelsForPlan(plan),
});

export const networkOwnershipLabels = (plan: AppPlan) => {
  const scratchId = scratchLabelsForPlan(plan)[SCRATCH_ID_LABEL];
  return privateNetworkLabels({
    ...planAppIdentity(plan),
    appId: plan.id,
    providerId: plan.provider,
    ...(scratchId === undefined ? {} : { scratchId }),
  });
};

/** Legacy labels require separate exact-name proof because native lookup also accepts ID prefixes. */
export const networkLabelsDecision = (
  labels: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
  recorded = false,
): "owned" | "legacy" | "foreign" => {
  if (labels === undefined || Object.keys(labels).length === 0)
    return SCRATCH_ID_LABEL in expected ? "foreign" : "legacy";
  const owner = labels[LANDO_DATA_ROOT_LABEL];
  const { [LANDO_DATA_ROOT_LABEL]: expectedOwner, ...proof } = expected;
  return matchesDataRoot(owner, expectedOwner, recorded) &&
    Object.keys(labels).length === Object.keys(proof).length + (owner === undefined ? 0 : 1) &&
    Object.entries(proof).every(([key, value]) => labels[key] === value)
    ? "owned"
    : "foreign";
};

export const isSharedNetwork = (plan: Pick<AppPlan, "networking">, name: string): boolean =>
  name === LANDO_SHARED_CROSS_APP_NETWORK || name === landoSharedNetworkName(plan);

const refused = (
  ctx: ProviderErrorContext,
  resource?: {
    readonly kind: "container" | "network";
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly expected: Readonly<Record<string, string>>;
    /** The label, or the native id, that failed verification. */
    readonly problem?: string;
  },
) => {
  const root = resource?.labels[APP_ROOT_LABEL];
  const dataRoot = resource?.labels[LANDO_DATA_ROOT_LABEL];
  const foreignDataRoot = dataRoot !== undefined && dataRoot !== resource?.expected[LANDO_DATA_ROOT_LABEL];
  const foreign =
    resource !== undefined &&
    root !== undefined &&
    root !== resource.expected[APP_ROOT_LABEL] &&
    (resource.kind === "container"
      ? coherentContainerOwnership(resource.labels, ctx.providerId)
      : coherentPrivateNetworkOwnership(resource.labels, ctx.providerId));
  return new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "resource-ownership",
    message: foreign
      ? `${resource.kind === "container" ? "Container" : "Network"} ${resource.name} already belongs to the Lando app at ${root}. Two apps can't use the same name.`
      : resource?.problem === undefined
        ? "Native resource ownership labels or identity could not be verified. No mutation is authorized."
        : `${resource.kind === "container" ? "Container" : "Network"} ${resource.name} failed ownership verification on its ${resource.problem}. No mutation is authorized.`,
    remediation: foreignDataRoot
      ? `Use the Lando installation with data root ${dataRoot} to manage this resource.`
      : foreign
        ? "Change `name:` in this app's .lando.yml (or destroy the other app) and run `lando start` again."
        : "Inspect the conflicting native resource and restore its verified Lando ownership or move it out of the planned name before retrying. Unlabeled resources cannot be adopted.",
    ...(foreign
      ? { details: { root } }
      : resource?.problem === undefined
        ? {}
        : { details: { [resource.kind]: resource.name, problem: resource.problem } }),
  });
};

export const verifiedNativeId = Effect.fnUntraced(function* (
  body: string,
  expected: Readonly<Record<string, string>>,
  ctx: ProviderErrorContext,
  resource: {
    readonly kind: "container" | "network";
    readonly name?: string;
    readonly receipts?: readonly AdoptionReceipt[];
  } = {
    kind: "container",
  },
) {
  const decoded = Schema.decodeUnknownOption(Observations)(body);
  if (Option.isNone(decoded)) return yield* Effect.fail(refused(ctx));
  const observed = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
  if (observed === undefined) return yield* Effect.fail(refused(ctx));
  const labels = observed.Config?.Labels ?? observed.Labels ?? observed.labels ?? {};
  const id = observed.Id ?? observed.ID ?? observed.id;
  const observedName = observed.Name ?? observed.name;
  const name =
    resource.name ??
    (typeof observedName === "string" && observedName.length > 0
      ? observedName.replace(/^\//u, "")
      : "resource");
  const dataRoot = expected[LANDO_DATA_ROOT_LABEL];
  const native = { kind: resource.kind, nativeName: name, nativeId: id, labels };
  if (
    dataRoot !== undefined &&
    decideDataRootOwnership(native, { dataRoot, receipts: resource.receipts ?? [] }) !== "owned"
  ) {
    return yield* new ProviderUnavailableError({
      providerId: ctx.providerId,
      operation: "resource-ownership",
      ...dataRootRefusal(native),
    });
  }
  const ownershipProblem =
    expected[APP_LABEL] === undefined
      ? Object.entries(expected).some(([key, value]) => labels[key] !== value)
        ? APP_LABEL
        : undefined
      : serviceContainerOwnershipProblem(labels, {
          app: expected[APP_LABEL] ?? "",
          appRoot: expected[APP_ROOT_LABEL] ?? "",
          service: expected[SERVICE_LABEL] ?? "",
          providerId: ctx.providerId,
          dataRoot: dataRoot === undefined ? undefined : labels[LANDO_DATA_ROOT_LABEL],
        });
  const scratchExpected = expected[SCRATCH_LABEL];
  const scratchMatches =
    scratchExpected === "TRUE"
      ? labels[SCRATCH_LABEL] === "TRUE" && labels[SCRATCH_ID_LABEL] === expected[SCRATCH_ID_LABEL]
      : labels[SCRATCH_LABEL] === undefined && labels[SCRATCH_ID_LABEL] === undefined;
  const problem =
    ownershipProblem !== undefined
      ? `${ownershipProblem} label`
      : !scratchMatches
        ? `${SCRATCH_LABEL} label`
        : !id
          ? "native id"
          : undefined;
  if (problem !== undefined)
    return yield* Effect.fail(refused(ctx, { kind: resource.kind, name, labels, expected, problem }));
  return id;
});

export const inspectOwnedNativeId = Effect.fn("NativeOwnership.inspect")(function* <E>(
  api: {
    readonly request?: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, E>;
  },
  target: (
    | { readonly kind: "container" }
    | {
        readonly kind: "network";
        readonly legacy: "accept" | "reject";
        readonly exactName?: true;
        readonly receipts?: readonly AdoptionReceipt[];
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
      return yield* verifiedNativeId(response.body, target.labels, ctx, {
        kind: "container",
        name: target.name,
      });
    case "network": {
      const decoded = Schema.decodeUnknownOption(Observations)(response.body);
      if (Option.isNone(decoded)) return yield* Effect.fail(refused(ctx));
      const observed = Array.isArray(decoded.value) ? decoded.value[0] : decoded.value;
      const id = observed?.Id ?? observed?.ID ?? observed?.id;
      const labels = observed?.Labels ?? observed?.labels ?? {};
      const exactName = (observed?.Name ?? observed?.name) === target.name;
      const dataRoot = target.labels[LANDO_DATA_ROOT_LABEL];
      const native = { kind: "network", nativeName: target.name, nativeId: id, labels } as const;
      if (
        dataRoot !== undefined &&
        decideDataRootOwnership(native, { dataRoot, receipts: exactName ? (target.receipts ?? []) : [] }) !==
          "owned"
      ) {
        return yield* new ProviderUnavailableError({
          providerId: ctx.providerId,
          operation: "resource-ownership",
          ...dataRootRefusal(native),
        });
      }
      const decision = networkLabelsDecision(
        Object.keys(labels).length === 0 ? undefined : labels,
        target.labels,
        dataRoot !== undefined,
      );
      if (
        !id ||
        (target.exactName === true && !exactName) ||
        decision === "foreign" ||
        (decision === "legacy" && (target.legacy === "reject" || !exactName))
      )
        return yield* Effect.fail(refused(ctx, { ...target, labels, expected: target.labels }));
      return id;
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
});
