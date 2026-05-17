import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

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

export class RuntimeBundleVerificationError extends ProviderUnavailableError {
  constructor(message: string, cause?: unknown) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message,
      remediation:
        "The Lando runtime bundle did not match its pinned checksum. Retry `lando setup`; if it fails again, report the release artifact and checksum.",
      cause,
    });
  }
}

export interface PodmanCommandRunner {
  readonly version: Effect.Effect<string, PodmanNotInstalledError>;
}

export interface RuntimeBundle {
  readonly version: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface RuntimeBundleDownloader {
  readonly download: Effect.Effect<RuntimeBundle, ProviderUnavailableError>;
}

export interface SetupOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly podmanCommand?: PodmanCommandRunner;
  readonly socketPath?: string;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly stateDir?: string;
}

export interface SetupResult {
  readonly podmanVersion: string;
  readonly runtimeBundleVersion?: string;
  readonly statePath?: string;
}

export const providerStatePath = (stateDir: string): string =>
  `${stateDir.replace(/\/+$/u, "")}/provider-lando/setup-state.json`;

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

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const normalizeSha256 = (checksum: string): string => checksum.replace(/^sha256:/u, "");

const verifyRuntimeBundle = (bundle: RuntimeBundle) =>
  Effect.try({
    try: () => {
      const actual = sha256Hex(bundle.bytes);
      const expected = normalizeSha256(bundle.sha256);
      if (actual !== expected) {
        throw new RuntimeBundleVerificationError("The Lando runtime bundle checksum did not match.", {
          expected,
          actual,
        });
      }
      return bundle;
    },
    catch: (cause) =>
      cause instanceof RuntimeBundleVerificationError
        ? cause
        : new RuntimeBundleVerificationError("Failed to verify the Lando runtime bundle checksum.", cause),
  });

const persistSetupState = (
  stateDir: string,
  state: {
    readonly podmanVersion: string;
    readonly runtimeBundleVersion?: string;
    readonly runtimeBundleSha256?: string;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const providerDir = `${stateDir.replace(/\/+$/u, "")}/provider-lando`;
      const statePath = providerStatePath(stateDir);

      await mkdir(providerDir, { recursive: true });
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

      return statePath;
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: "setup",
        message: "Unable to write provider-lando setup state.",
        remediation: `Check permissions for ${stateDir} and rerun \`lando setup\`.`,
        cause,
      }),
  });

export const setupProviderLando = (
  options: SetupOptions = {},
): Effect.Effect<SetupResult, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const bundle =
      options.runtimeBundleDownloader === undefined
        ? undefined
        : yield* options.runtimeBundleDownloader.download.pipe(Effect.flatMap(verifyRuntimeBundle));
    const podmanVersionOutput = yield* (options.podmanCommand ?? makeSystemPodmanCommandRunner()).version;
    const socketPath = options.socketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET;
    const api = options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));

    if (api === undefined) {
      return yield* Effect.fail(new PodmanSocketUnreachableError({ socketPath }));
    }

    // Provider setup validates the API socket after any pinned runtime bundle has been verified.
    const info = yield* api.info.pipe(Effect.mapError((cause) => new PodmanSocketUnreachableError(cause)));
    const podmanVersion = infoPodmanVersion(info) ?? parsePodmanVersion(podmanVersionOutput);
    const statePath =
      options.stateDir === undefined
        ? undefined
        : yield* persistSetupState(options.stateDir, {
            podmanVersion,
            ...(bundle === undefined
              ? {}
              : { runtimeBundleVersion: bundle.version, runtimeBundleSha256: bundle.sha256 }),
          });

    return {
      podmanVersion,
      ...(bundle === undefined ? {} : { runtimeBundleVersion: bundle.version }),
      ...(statePath === undefined ? {} : { statePath }),
    };
  });

export { MINIMUM_PODMAN_VERSION };
