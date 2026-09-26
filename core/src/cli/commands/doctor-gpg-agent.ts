import { discoverHostGpgAgent } from "@lando/engine/subsystems/gpg-agent/discovery";
import { resolveGpgAgentIntent } from "@lando/engine/subsystems/gpg-agent/intent";
import type { GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Either, Option } from "effect";

export const GPG_AGENT_SECURITY =
  "Services on apps that opt in can request signatures from this agent; private keys stay on the host.";

export interface GpgAgentPostureDetail {
  readonly forward: true;
  readonly upstream: { readonly source: "explicit" | "gpgconf" | "none"; readonly reachable: boolean };
  readonly keyringExported: boolean;
  readonly security: string;
}

export const gpgAgentPostureDetail = (input: {
  readonly landofile: Pick<LandofileShape, "gpgAgent">;
  readonly globalGpg?: GlobalConfig["gpgAgent"];
  readonly runner?: Pick<ProcessRunner["Type"], "run">;
  readonly exists?: (path: string) => Promise<boolean>;
}): Effect.Effect<GpgAgentPostureDetail | undefined> =>
  Effect.gen(function* () {
    const intent = resolveGpgAgentIntent({
      landofile: input.landofile,
      ...(input.globalGpg === undefined ? {} : { globalConfig: { gpgAgent: input.globalGpg } }),
    });
    if (intent.forward === false) return undefined;
    const provided = input.runner;
    const service = provided === undefined ? yield* Effect.serviceOption(ProcessRunner) : Option.none();
    const runner = provided ?? (Option.isSome(service) ? service.value : undefined);
    const exists = input.exists;
    const discovered =
      runner === undefined
        ? Either.left(undefined)
        : yield* Effect.either(
            discoverHostGpgAgent({
              runner,
              ...(intent.socket === undefined ? {} : { explicitSocket: intent.socket }),
              // Doctor only observes: it must never start a gpg-agent on the host.
              launch: false,
              ...(exists === undefined
                ? {}
                : { inspectPath: async (path: string) => ((await exists(path)) ? "socket" : "missing") }),
            }),
          );
    const exported =
      runner === undefined
        ? Either.left(undefined)
        : yield* Effect.either(runner.run({ cmd: "gpg", args: ["--batch", "--export"], timeoutMs: 5_000 }));
    return {
      forward: true,
      upstream: Either.isRight(discovered)
        ? { source: discovered.right.source, reachable: true }
        : { source: "none", reachable: false },
      keyringExported: Either.isRight(exported) && exported.right.exitCode === 0,
      security: GPG_AGENT_SECURITY,
    };
  });
