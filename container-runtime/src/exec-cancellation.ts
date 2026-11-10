import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError, ServiceExecError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan } from "@lando/sdk/schema";
import type { ExecTarget, ProviderError } from "@lando/sdk/services";
import { Duration, Effect, Exit, Schema } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "./engine-api.ts";
import { exec as transportExec } from "./podman/exec-transport.ts";

const ExecState = Schema.Struct({ Running: Schema.Boolean });

export const cancelWedgedExec = Effect.fnUntraced(function* (session: {
  readonly api: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly plan: AppPlan;
  readonly target: ExecTarget;
  readonly containerId: string;
  readonly helper: string;
  readonly nonce: string;
  readonly signal: AbortSignal | undefined;
  readonly execId: string;
}) {
  const unavailable = (cause?: unknown) =>
    new ProviderUnavailableError({
      providerId: session.ctx.providerId,
      operation: "exec",
      message: "Could not cancel and observe the container exec after its control channel stalled.",
      remediation: "Check the provider connection and service processes before retrying.",
      ...(cause === undefined ? {} : { cause }),
    });
  const result = yield* transportExec(
    session.plan,
    session.target,
    {
      command: [
        session.helper,
        "exec-signal",
        "--nonce",
        session.nonce,
        session.signal?.reason === "SIGINT" ? "INT" : "TERM",
      ],
      raw: true,
    },
    { api: session.api, ctx: session.ctx, raw: true, containerId: session.containerId },
  );
  if (result.exitCode !== 0 && result.exitCode !== 3) return yield* Effect.fail(unavailable());
  const request = session.api.request;
  if (request === undefined) return yield* Effect.fail(unavailable());
  let observed: Exit.Exit<boolean, ProviderError> = Exit.succeed(true);
  yield* runProbe(
    {
      id: "exec-disconnect-join",
      policy: { maxAttempts: 11, delay: Duration.millis(100) },
      classify: {
        success: () => (Exit.isFailure(observed) || !observed.value ? "green" : "yellow"),
        failure: () => "red",
      },
    },
    Effect.gen(function* () {
      const response = yield* request({
        method: "GET",
        path: `/exec/${encodeURIComponent(session.execId)}/json`,
      });
      if (response.status < 200 || response.status >= 300) return yield* Effect.fail(unavailable());
      const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExecState))(response.body).pipe(
        mapFailures(unavailable),
      );
      return state.Running;
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          observed = exit;
        }),
      ),
    ),
  ).pipe(mapFailures(unavailable));
  if (Exit.isFailure(observed)) return yield* Effect.failCause(observed.cause);
  if (observed.value)
    return yield* Effect.fail(
      new ServiceExecError({
        providerId: session.ctx.providerId,
        operation: "exec",
        service: session.target.service,
        message: "Container command supervision failed (cleanup-unconfirmed).",
        remediation: "Check the service container and provider connection, then retry.",
      }),
    );
});
