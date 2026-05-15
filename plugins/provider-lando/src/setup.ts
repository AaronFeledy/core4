import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import { type PodmanApiClient, makePodmanApiClient } from "./capabilities.ts";

const PROVIDER_ID = "lando";
const MINIMUM_PODMAN_VERSION = "4.9.0";

export class PodmanNotInstalledError extends ProviderUnavailableError {
  constructor(cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: "Podman is not installed or is not available on PATH.",
      remediation: `Install Podman >= ${MINIMUM_PODMAN_VERSION} and rerun \`lando setup\`.`,
      cause,
    });
  }
}

export class PodmanSocketUnreachableError extends ProviderUnavailableError {
  constructor(cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: "The Podman API socket is not reachable.",
      remediation: "Run `systemctl --user start podman.socket` and rerun `lando setup`.",
      cause,
    });
  }
}

export interface PodmanCommandRunner {
  readonly version: Effect.Effect<string, PodmanNotInstalledError>;
}

export interface SetupOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly podmanCommand?: PodmanCommandRunner;
  readonly socketPath?: string;
}

export interface SetupResult {
  readonly podmanVersion: string;
}

const readText = (stream: ReadableStream<Uint8Array> | null) =>
  stream === null ? Promise.resolve("") : new Response(stream).text();

export const makeSystemPodmanCommandRunner = (command = "podman"): PodmanCommandRunner => ({
  version: Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([command, "--version"], { stderr: "pipe", stdout: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        readText(proc.stdout),
        readText(proc.stderr),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new PodmanNotInstalledError({ stderr, exitCode });
      }

      return stdout.trim();
    },
    catch: (cause) => (cause instanceof PodmanNotInstalledError ? cause : new PodmanNotInstalledError(cause)),
  }),
});

const parsePodmanVersion = (versionOutput: string): string => {
  const match = /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(versionOutput);
  return match?.[0] ?? versionOutput;
};

const infoPodmanVersion = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) {
    return undefined;
  }

  const version = "version" in info ? info.version : undefined;
  if (typeof version === "object" && version !== null && "Version" in version) {
    const podmanVersion = version.Version;
    return typeof podmanVersion === "string" ? podmanVersion : undefined;
  }

  return undefined;
};

export const setupProviderLando = (
  options: SetupOptions = {},
): Effect.Effect<SetupResult, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const podmanVersionOutput = yield* (options.podmanCommand ?? makeSystemPodmanCommandRunner()).version;
    const socketPath = options.socketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET;
    const api = options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));

    if (api === undefined) {
      return yield* Effect.fail(new PodmanSocketUnreachableError({ socketPath }));
    }

    // MVP setup intentionally validates a manually-installed Podman + socket only.
    // The pinned runtime bundle download/verification path is deferred to Alpha.
    const info = yield* api.info.pipe(Effect.mapError((cause) => new PodmanSocketUnreachableError(cause)));
    return { podmanVersion: infoPodmanVersion(info) ?? parsePodmanVersion(podmanVersionOutput) };
  });

export { MINIMUM_PODMAN_VERSION };
