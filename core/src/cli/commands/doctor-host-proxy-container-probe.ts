import { Duration, Effect, Result, Schema } from "effect";

import { HOST_PROXY_CONTAINER_SOCKET } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { runProbe } from "@lando/sdk/probe";
import { AppId, CommandResultEnvelope, ServiceName } from "@lando/sdk/schema";
import type { ExecResult, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { compareCodePointStrings } from "./doctor-host-proxy-order";
import { OpenAppResultSchema } from "./open";

export type HostProxyContainerProbeResult = "reachable" | "failed" | "inconclusive" | "cap-exhausted";

interface HostProxyContainerProbeOptions {
  readonly providerExec: RuntimeProviderShape["exec"];
  readonly appId: string;
  readonly target:
    | { readonly kind: "tcp-host-gateway"; readonly containerUrl: string }
    | { readonly kind: "unix-socket" };
  readonly probeServices: ReadonlyArray<string>;
  readonly maxProbeServices: number;
}

const ExecResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
});

const validOpenEnvelope = (stdout: string): boolean => {
  try {
    const envelope = Schema.decodeUnknownResult(CommandResultEnvelope)(JSON.parse(stdout.trim()));
    if (Result.isFailure(envelope) || envelope.success.command !== "app:open") return false;
    if (!envelope.success.ok) return envelope.success.error !== undefined;
    return Result.isSuccess(Schema.decodeUnknownResult(OpenAppResultSchema)(envelope.success.result));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

export const probeHostProxyContainer = (
  options: HostProxyContainerProbeOptions,
): Effect.Effect<HostProxyContainerProbeResult> =>
  Effect.gen(function* () {
    const services = [...options.probeServices]
      .sort(compareCodePointStrings)
      .slice(0, options.maxProbeServices);
    let failed = false;
    for (const service of services) {
      const result = yield* runProbe<ExecResult, ProviderError, never>(
        {
          id: `doctor:host-proxy:${options.appId}`,
          policy: { maxAttempts: 1, timeout: Duration.seconds(5), backoff: "fixed" },
          classify: {
            success: (value) => {
              const execResult = Schema.decodeUnknownResult(ExecResultSchema)(value);
              if (Result.isFailure(execResult)) return "yellow";
              return validOpenEnvelope(execResult.success.stdout)
                ? "green"
                : execResult.success.exitCode === 127
                  ? "red"
                  : "yellow";
            },
            failure: () => "yellow",
          },
        },
        options.providerExec(
          { app: AppId.make(options.appId), service: ServiceName.make(service) },
          {
            command: ["/usr/local/bin/lando", "open", "--print"],
            env:
              options.target.kind === "unix-socket"
                ? { LANDO_HOST_PROXY_SOCKET: HOST_PROXY_CONTAINER_SOCKET }
                : { LANDO_HOST_PROXY_URL: options.target.containerUrl },
            stdin: "ignore",
            tty: false,
          },
        ),
      ).pipe(
        Effect.map((probeResult) => {
          if (probeResult.outcome === "green") return "reachable" as const;
          if (probeResult.outcome === "red" && probeResult.lastError === undefined) return "failed" as const;
          return "inconclusive" as const;
        }),
        Effect.catch(() => Effect.succeed("inconclusive" as const)),
      );
      if (result === "reachable") return result;
      if (result === "failed") failed = true;
    }
    if (options.probeServices.length > services.length) return "cap-exhausted";
    return failed ? "failed" : "inconclusive";
  });
