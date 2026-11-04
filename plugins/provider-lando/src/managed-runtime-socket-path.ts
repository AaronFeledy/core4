import {
  MANAGED_SOCKET_PATH_MAX_BYTES,
  managedSocketPathByteLength,
} from "@lando/container-runtime/podman/managed-invocation";
import { runtimeLayoutPaths } from "@lando/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { hostPlatformFamily } from "@lando/sdk/schema";
import { Effect } from "effect";

export const MANAGED_SOCKET_DATA_ROOT_SUFFIX = "/runtime/run/podman.sock";

/** Longest UTF-8 data-root length that still fits the 107-byte Unix socket cap. */
export const managedSocketMaxDataRootBytes =
  MANAGED_SOCKET_PATH_MAX_BYTES - managedSocketPathByteLength(MANAGED_SOCKET_DATA_ROOT_SUFFIX);

export const managedSocketPathForDataRoot = (userDataRoot: string): string =>
  runtimeLayoutPaths(userDataRoot, "linux").providerSocketPath;

export const managedSocketPathOverLimitRemediation = (
  maxDataRootBytes: number = managedSocketMaxDataRootBytes,
): string =>
  `Set LANDO_USER_DATA_ROOT to a path of at most ${maxDataRootBytes} bytes, then rerun the command.`;

interface ManagedSocketPathOverLimitInput {
  readonly socketPath: string;
  readonly providerId?: string;
  readonly operation?: string;
}

export const managedSocketPathOverLimitError = (
  input: ManagedSocketPathOverLimitInput,
): ProviderUnavailableError => {
  const bytes = managedSocketPathByteLength(input.socketPath);
  return new ProviderUnavailableError({
    providerId: input.providerId ?? "lando",
    operation: input.operation ?? "setup",
    message: `The managed Podman socket path is ${bytes} bytes, exceeding the Linux Unix socket limit of ${MANAGED_SOCKET_PATH_MAX_BYTES} bytes.`,
    remediation: managedSocketPathOverLimitRemediation(managedSocketMaxDataRootBytes),
    details: {
      socketPath: input.socketPath,
      bytes,
      limit: MANAGED_SOCKET_PATH_MAX_BYTES,
      maxDataRootBytes: managedSocketMaxDataRootBytes,
    },
  });
};

export const validateManagedSocketPathLength = (
  socketPath: string,
  options: Omit<ManagedSocketPathOverLimitInput, "socketPath"> = {},
): ProviderUnavailableError | undefined => {
  if (managedSocketPathByteLength(socketPath) <= MANAGED_SOCKET_PATH_MAX_BYTES) return undefined;
  return managedSocketPathOverLimitError({ socketPath, ...options });
};

export const makeManagedRuntimeSocketPathCheck = (): PluginDoctorCheckContribution => ({
  id: "managed-runtime-socket-path",
  run: (input) => {
    // Managed Linux/WSL only; machine-backed platforms use a pipe or connection name.
    if (input.providerId !== "lando" || hostPlatformFamily(input.platform) !== "linux")
      return Effect.succeed([]);
    if (input.userDataRoot === undefined) return Effect.succeed([]);

    const socketPath = managedSocketPathForDataRoot(input.userDataRoot);
    const error = validateManagedSocketPathLength(socketPath);
    if (error === undefined) return Effect.succeed([]);

    const report = {
      name: "managed-runtime-socket-path",
      status: "fail",
      severity: "error",
      runtimeStatus: error.message,
      context: {
        socketPath,
        bytes: String(managedSocketPathByteLength(socketPath)),
        limit: String(MANAGED_SOCKET_PATH_MAX_BYTES),
        maxDataRootBytes: String(managedSocketMaxDataRootBytes),
      },
      solutions: [
        {
          kind: "manual",
          description: error.remediation,
        },
      ],
    } satisfies PluginDoctorReport;

    return Effect.succeed([report]);
  },
});
