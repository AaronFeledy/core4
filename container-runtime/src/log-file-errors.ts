import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

import type { DataPlaneHttpResponse } from "./data-plane.ts";
import { tryParseJson } from "./engine-json.ts";

export const internal = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

export const unavailable = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

export const ensure2xx = (response: DataPlaneHttpResponse, providerId: string, details: unknown) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : Effect.fail(
        unavailable(providerId, `Docker-compatible API returned HTTP ${response.status}.`, details),
      );

export const parseExecId = (body: string, providerId: string) =>
  tryParseJson(body, (cause) =>
    internal(providerId, "Docker exec create returned malformed JSON.", body, cause),
  ).pipe(
    Effect.flatMap((decoded) =>
      typeof decoded === "object" && decoded !== null && "Id" in decoded && typeof decoded.Id === "string"
        ? Effect.succeed(decoded.Id)
        : Effect.fail(internal(providerId, "Docker exec create omitted Id.", decoded)),
    ),
  );
