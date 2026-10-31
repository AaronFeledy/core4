import { taggedErrorJson } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ServiceShutdownObservation } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { missingApi } from "./engine-errors.ts";
import { redactorFor } from "./redact.ts";

export type ShutdownIdentity = Pick<
  ServiceShutdownObservation,
  "appId" | "providerId" | "service" | "containerId"
>;

const State = Schema.Struct({
  Status: Schema.optionalKey(Schema.Unknown),
  Running: Schema.optionalKey(Schema.Unknown),
  ExitCode: Schema.optionalKey(Schema.Unknown),
  OOMKilled: Schema.optionalKey(Schema.Unknown),
});
const Inspect = Schema.fromJsonString(Schema.Struct({ State: Schema.optionalKey(Schema.NullOr(State)) }));

export const absentShutdown = (identity: ShutdownIdentity): ServiceShutdownObservation => ({
  ...identity,
  status: "unknown",
  reason: "container-absent",
});

export const observeShutdown = Effect.fn("ShutdownObservation.inspect")(function* (
  identity: ShutdownIdentity & { readonly containerId: string },
  options: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
): Effect.fn.Return<ServiceShutdownObservation> {
  const inspect = Effect.gen(function* () {
    const request = options.api.request;
    if (request === undefined) return yield* Effect.fail(missingApi(options.ctx, "shutdown.inspect"));
    const response = yield* request({
      method: "GET",
      path: `/containers/${encodeURIComponent(identity.containerId)}/json`,
    });
    if (response.status === 404) return absentShutdown(identity);
    if (response.status !== 200)
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: options.ctx.providerId,
          operation: "shutdown.inspect",
          message: `Container shutdown inspection failed with HTTP ${response.status}.`,
          remediation: options.ctx.remediation,
        }),
      );
    const decoded = Schema.decodeUnknownOption(Inspect)(response.body);
    const state = Option.isSome(decoded) ? decoded.value.State : undefined;
    const base = {
      ...identity,
      ...(typeof state?.OOMKilled === "boolean" ? { oomKilled: state.OOMKilled } : {}),
    };
    if (state === undefined || state === null)
      return { ...base, status: "unknown", reason: "state-unavailable" } satisfies ServiceShutdownObservation;
    if (state.Running !== true && typeof state.Status !== "string")
      return { ...base, status: "unknown", reason: "state-unavailable" } satisfies ServiceShutdownObservation;
    // Created containers commonly report ExitCode=0 without ever having run.
    if (state.Running === true || (state.Status !== "exited" && state.Status !== "stopped")) {
      return { ...base, status: "unknown", reason: "not-exited" } satisfies ServiceShutdownObservation;
    }
    return {
      ...base,
      status: "exited",
      ...(typeof state.ExitCode === "number" && Number.isInteger(state.ExitCode)
        ? { exitCode: state.ExitCode }
        : {}),
    } satisfies ServiceShutdownObservation;
  });
  return yield* inspect.pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: options.ctx.providerId,
            operation: "shutdown.inspect",
            message: "Container shutdown inspection timed out.",
            remediation: options.ctx.remediation,
          }),
        ),
    }),
    Effect.catch((error) => {
      const diagnostic = taggedErrorJson(error);
      const redactor = redactorFor(options.ctx);
      // Only canonical identity/message/remediation cross this boundary, never transport details.
      return Effect.succeed({
        ...identity,
        status: "unknown",
        reason: "inspect-failed",
        diagnostic: {
          _tag: diagnostic._tag,
          message: redactor.redactString(diagnostic.message),
          remediation: redactor.redactString(diagnostic.remediation),
        },
      } satisfies ServiceShutdownObservation);
    }),
  );
});
