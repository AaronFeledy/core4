import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { Effect, Schema, type Scope } from "effect";

import { ToolExtractError, ToolInstallPathError, ToolManifestError } from "@lando/sdk/errors";
import { ToolManifest, type ToolManifest as ToolManifestType } from "@lando/sdk/schema";
import { type Downloader, ProcessRunner } from "@lando/sdk/services";
import {
  type ToolError,
  fingerprintPath,
  provisionTool,
  readInstalledToolVersion,
  recordedFingerprintMatch,
  resolveHostKey,
  toolVersionMarkerPath,
} from "@lando/sdk/tool-provisioning";

import manifestData from "../docker-cli-versions.json" with { type: "json" };

const TOOL_ID = "mutagen-docker-cli" as const;
const INSTALL_NAME = "mutagen-docker/docker.exe" as const;

export const DOCKER_CLI_TOOL_MANIFEST = Schema.decodeUnknownSync(ToolManifest)(manifestData);
export const DOCKER_CLI_TOOL_VERSION = DOCKER_CLI_TOOL_MANIFEST.toolVersion;
export const DOCKER_CLI_EXECUTABLE_SHA256 =
  "ae4b16d8f152c03db73a9c9e33f89874ec640bfe2128dbd776a172059c94280d";
export const DOCKER_CLI_EXECUTABLE_SIZE_BYTES = 42072064;

export interface ProvisionDockerCliInput {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly force?: boolean | undefined;
  readonly offline?: boolean | undefined;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
}

export interface InstalledDockerCliStatus {
  readonly installedVersion?: string;
  readonly isCurrent: boolean;
}

export const dockerCliInstallPath = (binDir: string): string => join(binDir, INSTALL_NAME);

export const dockerCliConfigDir = (binDir: string): string => join(binDir, "mutagen-docker", "config");

export const dockerCliInstalledVersionPath = (binDir: string): string =>
  toolVersionMarkerPath(binDir, TOOL_ID);

const isContained = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
};

const isRegularUnlinkedFile = async (path: string, sizeBytes?: number): Promise<boolean> => {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && (sizeBytes === undefined || info.size === sizeBytes);
  } catch {
    return false;
  }
};

const isContainedInstallParent = async (binDir: string, installPath: string): Promise<boolean> => {
  try {
    const [root, parent] = await Promise.all([realpath(binDir), realpath(dirname(installPath))]);
    return isContained(root, parent);
  } catch {
    return false;
  }
};

const isEmptyPrivateConfigDir = async (binDir: string): Promise<boolean> => {
  const path = dockerCliConfigDir(binDir);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const [root, actual, entries] = await Promise.all([realpath(binDir), realpath(path), readdir(path)]);
    return isContained(root, actual) && entries.length === 0;
  } catch {
    return false;
  }
};

const configPathError = (cause: unknown): ToolInstallPathError =>
  new ToolInstallPathError({
    message: "Could not prepare an empty owner-private Docker CLI config directory.",
    toolId: TOOL_ID,
    installName: "mutagen-docker/config",
    remediation: "Check access to the private Lando bin directory and rerun setup.",
    cause,
  });

const ensurePrivateConfigDir = Effect.fn("MutagenDockerCli.ensurePrivateConfigDir")(function* (
  binDir: string,
  platform: string,
): Effect.fn.Return<void, ToolInstallPathError, ProcessRunner> {
  const path = dockerCliConfigDir(binDir);
  yield* Effect.tryPromise({
    try: async () => {
      const parent = dirname(path);
      await mkdir(binDir, { recursive: true });
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new Error("Docker CLI install parent is not a real directory.");
      }
      const [root, actualParent] = await Promise.all([realpath(binDir), realpath(parent)]);
      if (!isContained(root, actualParent)) {
        throw new Error("Docker CLI install parent escapes the private bin directory.");
      }
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Docker CLI config is not a real directory.");
      }
      const [actual, entries] = await Promise.all([realpath(path), readdir(path)]);
      if (!isContained(root, actual)) throw new Error("Docker CLI config escapes the private bin directory.");
      if (entries.length !== 0) throw new Error("Docker CLI config directory is not empty.");
    },
    catch: configPathError,
  });

  // Simulated win32 provision tests run on Unix; only the real Windows host
  // needs an explicit DACL because Windows ignores POSIX directory modes.
  if (platform === "win32" && process.platform === "win32") {
    const runner = yield* ProcessRunner;
    const runHidden = Effect.fn("DockerCliProvision.runHidden")(function* (
      cmd: string,
      args: readonly string[],
    ) {
      const result = yield* runner
        .run({ cmd, args, timeoutMs: 15000, windowsHide: true })
        .pipe(Effect.mapError(configPathError));
      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          configPathError(new Error(`ACL command failed with exit code ${result.exitCode}.`)),
        );
      }
      return result.stdout;
    });
    const identity = yield* runHidden("whoami", ["/user", "/fo", "csv", "/nh"]);
    const sid = identity.match(/S-\d-(?:\d+-)+\d+/u)?.[0];
    if (sid === undefined) {
      return yield* Effect.fail(
        configPathError(new Error("Could not identify the current Windows user SID.")),
      );
    }
    yield* runHidden("icacls", [path, "/reset"]);
    yield* runHidden("icacls", [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`]);
  }
});

/**
 * Private test seam: fixture archives can exercise the same installer without
 * replacing the production checksum pins. Only the instance below is wired into
 * the bundled plugin.
 */
export const makeDockerCliProvisioner = (pins: {
  readonly manifest: ToolManifestType;
  readonly executableSha256: string;
  readonly executableSizeBytes: number;
}) => {
  const readStatus = async (
    binDir: string,
    platform: string = process.platform,
    arch: string = process.arch,
  ): Promise<InstalledDockerCliStatus> => {
    const marker = dockerCliInstalledVersionPath(binDir);
    const installedVersion = await readInstalledToolVersion([marker]);
    const base = installedVersion === undefined ? {} : { installedVersion };
    if (resolveHostKey(platform, arch) !== "win32-x64" || installedVersion !== pins.manifest.toolVersion) {
      return { ...base, isCurrent: false };
    }
    const installPath = dockerCliInstallPath(binDir);
    if (
      !(await isContainedInstallParent(binDir, installPath)) ||
      !(await isRegularUnlinkedFile(marker)) ||
      !(await isRegularUnlinkedFile(installPath, pins.executableSizeBytes)) ||
      !(await isRegularUnlinkedFile(fingerprintPath(installPath))) ||
      !(await isEmptyPrivateConfigDir(binDir))
    ) {
      return { ...base, isCurrent: false };
    }
    return {
      ...base,
      isCurrent: (await recordedFingerprintMatch(installPath)) === pins.executableSha256,
    };
  };

  const rejectSymlinkedLeaf = (path: string): Effect.Effect<void, ToolInstallPathError> =>
    Effect.tryPromise({
      try: async () => {
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (info?.isSymbolicLink()) {
          throw new ToolInstallPathError({
            message: `The Docker CLI install path contains a symlinked file: ${path}.`,
            toolId: TOOL_ID,
            installName: INSTALL_NAME,
            remediation: "Remove the symlink from the private Lando bin directory, then rerun setup.",
          });
        }
      },
      catch: (cause) =>
        cause instanceof ToolInstallPathError
          ? cause
          : new ToolInstallPathError({
              message: `Could not inspect the Docker CLI install path: ${path}.`,
              toolId: TOOL_ID,
              installName: INSTALL_NAME,
              remediation: "Check access to the private Lando bin directory, then rerun setup.",
              cause,
            }),
    });

  const provision = Effect.fn("MutagenDockerCli.provision")(function* (
    input: ProvisionDockerCliInput,
  ): Effect.fn.Return<void, ToolError, Downloader | ProcessRunner | Scope.Scope> {
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;
    const hostKey = resolveHostKey(platform, arch);
    if (hostKey !== "win32-x64" || pins.manifest.artifacts[hostKey] === undefined) {
      return yield* Effect.fail(
        new ToolManifestError({
          message: `No pinned private Docker CLI is available for ${hostKey}.`,
          toolId: TOOL_ID,
          key: hostKey,
          remediation: "Use the Windows x64 Mutagen transport on a supported host.",
        }),
      );
    }

    yield* ensurePrivateConfigDir(input.binDir, platform);

    if (input.force !== true) {
      const installed = yield* Effect.promise(() => readStatus(input.binDir, platform, arch));
      if (installed.isCurrent) return;
    }

    const installPath = dockerCliInstallPath(input.binDir);
    yield* rejectSymlinkedLeaf(installPath);
    yield* rejectSymlinkedLeaf(fingerprintPath(installPath));
    yield* rejectSymlinkedLeaf(dockerCliInstalledVersionPath(input.binDir));

    yield* provisionTool({
      manifest: pins.manifest,
      key: hostKey,
      toolId: TOOL_ID,
      binDir: input.binDir,
      toolDownloadsDir: input.toolDownloadsDir,
      platform,
      // A matching version marker and locally rewritten fingerprint cannot
      // bypass the pinned executable checksum. Repair any non-current install.
      force: true,
      ...(input.offline === undefined ? {} : { offline: input.offline }),
    });

    const installed = yield* Effect.promise(() => readStatus(input.binDir, platform, arch));
    if (!installed.isCurrent) {
      return yield* Effect.fail(
        new ToolExtractError({
          message: "The installed Docker CLI did not match its pinned executable fingerprint.",
          toolId: TOOL_ID,
          member: "docker/docker.exe",
          remediation:
            "Remove the private Docker CLI install and rerun setup; report a reproducible archive mismatch.",
        }),
      );
    }
  });

  return { provision, readStatus };
};

const bundled = makeDockerCliProvisioner({
  manifest: DOCKER_CLI_TOOL_MANIFEST,
  executableSha256: DOCKER_CLI_EXECUTABLE_SHA256,
  executableSizeBytes: DOCKER_CLI_EXECUTABLE_SIZE_BYTES,
});

export const provisionDockerCli = bundled.provision;
export const readInstalledDockerCliStatus = bundled.readStatus;
