import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import {
  type ManagedStatusPaths,
  inspectSilentManagedRuntime,
} from "@lando/container-runtime/podman/managed-status-io";
import type { RuntimeShutdownReceipt } from "@lando/container-runtime/podman/runtime-shutdown";
import { ContainerTransportError } from "@lando/container-runtime/transport";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderError, ProviderStatus } from "@lando/sdk/services";
import { Effect } from "effect";
import type { PodmanMachineRunner } from "./setup.ts";

export const providerStatus = (options: {
  readonly api: PodmanApiClient | undefined;
  readonly managedPaths: ManagedStatusPaths | undefined;
  readonly platform: string;
  readonly machine: Pick<PodmanMachineRunner, "inspect"> | undefined;
  readonly receipt?: Effect.Effect<RuntimeShutdownReceipt | null, unknown>;
}): Effect.Effect<ProviderStatus, ProviderError> => {
  const unavailable = new ProviderUnavailableError({
    providerId: "lando",
    operation: "getStatus",
    message: "The managed runtime endpoint is not available.",
    remediation:
      "Run `lando setup` if the runtime is not installed; otherwise inspect it with `lando doctor`.",
  });
  const probe = options.api?.info ?? Effect.fail(unavailable);
  return probe.pipe(
    Effect.as({ state: "running" as const, message: "runtime socket reachable" }),
    Effect.catch((error): Effect.Effect<ProviderStatus, ProviderError> => {
      if (!(error instanceof ProviderUnavailableError)) return Effect.fail(error);
      const transport = error.cause;
      if (!(transport instanceof ContainerTransportError) || transport.kind !== "connect")
        return Effect.fail(error);
      const cause = transport.cause;
      if (
        !(cause instanceof Error) ||
        !("code" in cause) ||
        (cause.code !== "ENOENT" && cause.code !== "ECONNREFUSED")
      )
        return Effect.fail(error);
      if (options.managedPaths === undefined) return Effect.fail(error);
      if (options.platform === "linux")
        return inspectSilentManagedRuntime(options.managedPaths, options.receipt);
      if (options.machine === undefined) return Effect.fail(error);
      return options.machine.inspect.pipe(
        Effect.flatMap((state) => {
          switch (state) {
            case "stopped":
              return Effect.succeed({ state: "idle" as const, message: "idle (starts on demand)" });
            case "missing":
              return Effect.fail(unavailable);
            case "running":
              return Effect.fail(error);
            default: {
              const exhaustive: never = state;
              return exhaustive;
            }
          }
        }),
      );
    }),
  );
};
