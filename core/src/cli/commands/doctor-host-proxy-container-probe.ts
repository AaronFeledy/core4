import { Duration, Effect, Either, Schema } from "effect";

import { runProbe } from "@lando/sdk/probe";
import { AppId, CommandResultEnvelope, ServiceName } from "@lando/sdk/schema";
import type { ExecResult, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { compareCodePointStrings } from "./doctor-host-proxy-order.ts";
import { OpenAppResultSchema } from "./open.ts";

export type HostProxyContainerProbeResult = "reachable" | "failed" | "inconclusive" | "cap-exhausted";

interface HostProxyContainerProbeOptions {
  readonly providerExec: RuntimeProviderShape["exec"];
  readonly appId: string;
  readonly containerUrl: string;
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
    const envelope = Schema.decodeUnknownEither(CommandResultEnvelope)(JSON.parse(stdout.trim()));
    if (Either.isLeft(envelope) || envelope.right.command !== "app:open") return false;
    if (!envelope.right.ok) return envelope.right.error !== undefined;
    return Either.isRight(Schema.decodeUnknownEither(OpenAppResultSchema)(envelope.right.result));
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
              const execResult = Schema.decodeUnknownEither(ExecResultSchema)(value);
              if (Either.isLeft(execResult)) return "yellow";
              return validOpenEnvelope(execResult.right.stdout)
                ? "green"
                : execResult.right.exitCode === 127
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
            env: { LANDO_HOST_PROXY_URL: options.containerUrl },
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
        Effect.catchAll(() => Effect.succeed("inconclusive" as const)),
      );
      if (result === "reachable") return result;
      if (result === "failed") failed = true;
    }
    if (options.probeServices.length > services.length) return "cap-exhausted";
    return failed ? "failed" : "inconclusive";
  });
