import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { ProviderError, ServiceExitResult, ServiceSelector } from "@lando/sdk/services";

import type { DockerApiClient, DockerHttpRequest, DockerHttpResponse } from "./index.ts";
import { redactDetails, redactString } from "./redact.ts";

const PROVIDER_ID = "docker";

export interface WaitForExitOptions {
  readonly dockerApi?: DockerApiClient;
  readonly signal?: AbortSignal;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const missingApi = (operation: string) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: `provider-docker ${operation} requires a Docker API client.`,
  });

const missingService = (target: ServiceSelector) =>
  new ServiceNotFoundError({
    providerId: PROVIDER_ID,
    operation: "waitForExit",
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const request = (
  api: DockerApiClient,
  operation: string,
  input: DockerHttpRequest,
): Effect.Effect<DockerHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  api.request === undefined ? Effect.fail(missingApi(operation)) : api.request(input);

const apiReasonFromBody = (details: unknown): string | undefined => {
  if (typeof details !== "object" || details === null || !("body" in details)) return undefined;
  const body = details.body;
  if (typeof body !== "string" || body.trim().length === 0) return undefined;
  let reason: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = "message" in parsed ? parsed.message : undefined;
      const fallback = "cause" in parsed ? parsed.cause : undefined;
      if (typeof candidate === "string" && candidate.trim().length > 0) reason = candidate.trim();
      else if (typeof fallback === "string" && fallback.trim().length > 0) reason = fallback.trim();
    }
  } catch {
    return undefined;
  }
  return reason === undefined ? undefined : redactString(reason);
};

const withApiReason = (message: string, details: unknown): string => {
  const reason = apiReasonFromBody(details);
  return reason === undefined ? message : `${message} ${reason}`;
};

const apiFailure = (service: ServicePlan, response: DockerHttpResponse) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "waitForExit",
    message: withApiReason(`Docker wait failed with HTTP ${response.status}.`, response),
    details: redactDetails({ service: service.name, body: response.body }),
    remediation: "Inspect the service container state and retry the operation.",
  });

const parseJson = (response: DockerHttpResponse): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: (): unknown => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: PROVIDER_ID,
        operation: "waitForExit",
        message: "Docker API returned malformed JSON.",
        cause,
      }),
  });

export const waitForExit = (
  plan: AppPlan,
  target: ServiceSelector,
  options: WaitForExitOptions = {},
): Effect.Effect<ServiceExitResult, ProviderError> => {
  const service = plan.services[target.service];
  if (service === undefined) return Effect.fail(missingService(target));
  if (options.dockerApi === undefined) return Effect.fail(missingApi("waitForExit"));

  const dockerApi = options.dockerApi;
  const name = encodeURIComponent(containerName(plan, service));
  return Effect.gen(function* () {
    const waitResponse = yield* request(dockerApi, "waitForExit", {
      method: "POST",
      path: `/containers/${name}/wait`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (waitResponse.status < 200 || waitResponse.status >= 300) {
      return yield* Effect.fail(apiFailure(service, waitResponse));
    }

    const decoded = yield* parseJson(waitResponse);
    const exitCode =
      typeof decoded === "object" && decoded !== null && "StatusCode" in decoded
        ? decoded.StatusCode
        : undefined;
    if (typeof exitCode !== "number") {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: PROVIDER_ID,
          operation: "waitForExit",
          message: "Docker wait did not return a numeric container exit code.",
          details: { service: service.name },
          remediation: "Check the Docker API version and retry the operation.",
        }),
      );
    }
    return { exitCode };
  });
};
