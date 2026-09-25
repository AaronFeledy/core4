import { GpgAgentUnavailableError } from "@lando/sdk/errors";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";

export interface GpgAgentDiscoveryOptions {
  readonly runner: Pick<ProcessRunner["Type"], "run">;
  readonly explicitSocket?: string;
  readonly exists: (path: string) => Promise<boolean>;
}

export interface HostGpgAgent {
  readonly _tag: "unix";
  readonly path: string;
  readonly source: "gpgconf" | "explicit";
}

export const discoverHostGpgAgent = (
  options: GpgAgentDiscoveryOptions,
): Effect.Effect<HostGpgAgent, GpgAgentUnavailableError> =>
  Effect.gen(function* () {
    const unavailable = (reason: GpgAgentUnavailableError["reason"]) =>
      new GpgAgentUnavailableError({
        message: "The host GPG agent is unavailable.",
        reason,
        remediation:
          "Install GnuPG, run `gpgconf --launch gpg-agent`, and set gpgAgent.socket to the restricted extra socket if needed.",
      });
    const run = (args: ReadonlyArray<string>) =>
      options.runner
        .run({ cmd: "gpgconf", args, timeoutMs: 5_000 })
        .pipe(Effect.mapError(() => unavailable("gpg-missing")));
    const path = yield* options.explicitSocket === undefined
      ? run(["--list-dirs", "agent-extra-socket"]).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout.trim())
              : Effect.fail(unavailable("gpg-missing")),
          ),
        )
      : Effect.succeed(options.explicitSocket);
    if (path.length === 0) return yield* Effect.fail(unavailable("host-agent-not-found"));
    const exists = () =>
      Effect.tryPromise({ try: () => options.exists(path), catch: () => unavailable("socket-missing") });
    if ((yield* exists()) === false) {
      yield* run(["--launch", "gpg-agent"]);
      if ((yield* exists()) === false) {
        return yield* Effect.fail(
          new GpgAgentUnavailableError({
            message: "The host GPG agent socket is missing.",
            reason: "socket-missing",
            remediation:
              "Set gpgAgent.socket to the restricted extra socket, or run `gpgconf --launch gpg-agent` and retry.",
          }),
        );
      }
    }
    return { _tag: "unix", path, source: options.explicitSocket === undefined ? "gpgconf" : "explicit" };
  });
