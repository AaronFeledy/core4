import { lstat } from "node:fs/promises";
import { GpgAgentUnavailableError } from "@lando/sdk/errors";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { probeRestrictedGpgAgent } from "./assuan-probe.ts";

export type GpgSocketPathKind = "socket" | "missing" | "other";

export interface GpgAgentDiscoveryOptions {
  readonly runner: Pick<ProcessRunner["Type"], "run">;
  readonly explicitSocket?: string;
  /** Whether a missing socket may be repaired with `gpgconf --launch gpg-agent`. Read-only probes pass false. */
  readonly launch: boolean;
  readonly inspectPath?: (path: string) => Promise<GpgSocketPathKind>;
  readonly probeRestricted?: typeof probeRestrictedGpgAgent;
}

export interface HostGpgAgent {
  readonly _tag: "unix";
  readonly path: string;
  readonly source: "gpgconf" | "explicit";
}

const PROBE_TIMEOUT_MS = 2_000;
const RESTRICTED_SOCKET_REMEDIATION =
  "Point gpgAgent.socket at the restricted extra socket reported by `gpgconf --list-dirs agent-extra-socket`, or run `gpgconf --launch gpg-agent` and retry.";

/** lstat so a symlink is judged by itself, never by what it points at. */
const inspectSocketPath = async (path: string): Promise<GpgSocketPathKind> => {
  try {
    return (await lstat(path)).isSocket() ? "socket" : "other";
  } catch {
    return "missing";
  }
};

export const discoverHostGpgAgent = (
  options: GpgAgentDiscoveryOptions,
): Effect.Effect<HostGpgAgent, GpgAgentUnavailableError> =>
  Effect.gen(function* () {
    const unavailable = (reason: GpgAgentUnavailableError["reason"], socketPath?: string) =>
      new GpgAgentUnavailableError({
        message:
          reason === "unrestricted-socket"
            ? "The configured GPG agent socket is not the restricted extra socket."
            : "The host GPG agent is unavailable.",
        reason,
        ...(socketPath === undefined ? {} : { socketPath }),
        remediation:
          reason === "gpg-missing"
            ? "Install GnuPG, run `gpgconf --launch gpg-agent`, and set gpgAgent.socket to the restricted extra socket if needed."
            : RESTRICTED_SOCKET_REMEDIATION,
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
    const inspect = Effect.tryPromise({
      try: () => (options.inspectPath ?? inspectSocketPath)(path),
      catch: () => unavailable("socket-missing", path),
    });
    let kind = yield* inspect;
    if (kind === "missing" && options.launch) {
      yield* run(["--launch", "gpg-agent"]);
      kind = yield* inspect;
    }
    if (kind !== "socket") return yield* Effect.fail(unavailable("socket-missing", path));
    const restriction = yield* Effect.tryPromise({
      try: () => (options.probeRestricted ?? probeRestrictedGpgAgent)(path, { timeoutMs: PROBE_TIMEOUT_MS }),
      catch: () => unavailable("socket-missing", path),
    });
    if (restriction === "unrestricted") return yield* Effect.fail(unavailable("unrestricted-socket", path));
    return { _tag: "unix", path, source: options.explicitSocket === undefined ? "gpgconf" : "explicit" };
  });
