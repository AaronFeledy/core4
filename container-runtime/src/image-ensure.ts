import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";

import type { PullDialect } from "./dialect.ts";
import { parseImagePlatform } from "./dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { missingApi, parseEngineJson } from "./engine-errors.ts";
import { type PullImageOptions, pullImage } from "./image-pull.ts";
import { redactDetails } from "./redact.ts";

export interface EnsureImageOptions<E = never> {
  readonly ctx: ProviderErrorContext;
  readonly dialect: PullDialect;
  readonly force?: boolean;
  readonly platform?: string;
  readonly publish?: PullImageOptions<E>["publish"];
}

const inspectRequest = (dialect: PullDialect, reference: string): EngineHttpRequest =>
  dialect.inspect?.request(reference) ?? {
    method: "GET",
    path: `/libpod/images/${encodeURIComponent(reference)}/json`,
  };

const request = (
  api: EngineHttpApi,
  ctx: ProviderErrorContext,
  input: EngineHttpRequest,
): Effect.Effect<EngineHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  api.request === undefined
    ? Effect.fail(
        missingApi(
          ctx,
          "apply",
          `provider-${ctx.providerId} apply requires a container engine API client.`,
        ),
      )
    : api.request(input);

const textField = (json: unknown, key: string): string | undefined => {
  if (typeof json !== "object" || json === null || !(key in json)) return undefined;
  const value = Reflect.get(json, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const inspectRepoDigests = (json: unknown): ReadonlyArray<string> => {
  if (typeof json !== "object" || json === null || !("RepoDigests" in json)) return [];
  const value = json.RepoDigests;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
};

const inspectMatchesPlatform = (inspect: unknown, platform: string): boolean => {
  const pin = parseImagePlatform(platform);
  if (pin === undefined) return true;
  const os = textField(inspect, "Os");
  const architecture = textField(inspect, "Architecture");
  if (os === undefined || architecture === undefined) return false;
  if (os.toLowerCase() !== pin.os.toLowerCase()) return false;
  if (architecture.toLowerCase() !== pin.architecture.toLowerCase()) return false;
  if (pin.variant === undefined) return true;
  const variant = textField(inspect, "Variant");
  return variant === undefined || variant.toLowerCase() === pin.variant.toLowerCase();
};

const localPlatformLabel = (inspect: unknown): string => {
  const os = textField(inspect, "Os") ?? "unknown";
  const architecture = textField(inspect, "Architecture") ?? "unknown";
  const variant = textField(inspect, "Variant");
  return variant === undefined ? `${os}/${architecture}` : `${os}/${architecture}/${variant}`;
};

export const serviceImagePlatform = (service: ServicePlan): string | undefined => {
  const compose = service.extensions.compose;
  if (typeof compose !== "object" || compose === null || Array.isArray(compose)) return undefined;
  const platform = Reflect.get(compose, "platform");
  return typeof platform === "string" && platform.length > 0 ? platform : undefined;
};

const pull = <E = never>(api: EngineHttpApi, reference: string, options: EnsureImageOptions<E>) =>
  pullImage(api, reference, {
    ctx: options.ctx,
    dialect: options.dialect,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.publish === undefined ? {} : { publish: options.publish }),
  }).pipe(Effect.asVoid);

const localBuildPlatformError = (
  ctx: ProviderErrorContext,
  reference: string,
  platform: string,
  inspect: unknown,
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "apply",
    message: `Local image ${reference} is ${localPlatformLabel(inspect)} but the service pins ${platform}.`,
    details: redactDetails({
      reference,
      local: localPlatformLabel(inspect),
      platform,
    }),
    remediation:
      "Rebuild the image for the pinned platform, or delete the local tag so Lando can pull the matching registry image.",
  });

const inspectFailure = (
  ctx: ProviderErrorContext,
  response: EngineHttpResponse,
): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "apply",
    message: `Image inspect failed with HTTP ${response.status}.`,
    details: redactDetails(response),
    remediation: ctx.remediation,
  });

export const ensureImage = <E = never>(
  api: EngineHttpApi,
  reference: string,
  options: EnsureImageOptions<E>,
): Effect.Effect<void, ProviderUnavailableError | ProviderInternalError | E> => {
  if (options.force === true) return pull(api, reference, options);
  return Effect.gen(function* () {
    const inspectResponse = yield* request(api, options.ctx, inspectRequest(options.dialect, reference));
    if (inspectResponse.status === 404) {
      yield* pull(api, reference, options);
      return;
    }
    if (inspectResponse.status !== 200) {
      return yield* Effect.fail(inspectFailure(options.ctx, inspectResponse));
    }
    if (options.platform === undefined) return;
    const decoded = yield* parseEngineJson(inspectResponse, options.ctx, "apply", {
      message: "Container engine API returned malformed JSON.",
      details: redactDetails(inspectResponse),
    });
    if (inspectMatchesPlatform(decoded, options.platform)) return;
    if (inspectRepoDigests(decoded).length > 0) {
      yield* pull(api, reference, options);
      return;
    }
    return yield* Effect.fail(
      localBuildPlatformError(options.ctx, reference, options.platform, decoded),
    );
  });
};

export const makeEnsureImage =
  <E = never>(
    api: EngineHttpApi,
    options: Omit<EnsureImageOptions<E>, "force" | "platform">,
  ): ((input: {
    readonly service: ServicePlan;
    readonly ref: string;
    readonly force: boolean;
  }) => Effect.Effect<void, ProviderUnavailableError | ProviderInternalError | E>) =>
  ({ service, ref, force }) =>
    ensureImage(api, ref, {
      ...options,
      force,
      ...(serviceImagePlatform(service) === undefined
        ? {}
        : { platform: serviceImagePlatform(service) }),
    });
