import { randomUUID } from "node:crypto";
import { readLinuxBootId } from "@lando/container-runtime/podman/managed-status-io";
import {
  RUNTIME_SHUTDOWN_KEY,
  RUNTIME_SHUTDOWN_VERSION,
  RuntimeShutdownReceipt,
} from "@lando/container-runtime/podman/runtime-shutdown";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { defineTransitions } from "@lando/sdk/transitions";
import { Effect } from "effect";

export const shutdownTransitions = defineTransitions<
  RuntimeShutdownReceipt["state"] | "absent" | "superseded"
>()({
  admit: { from: ["absent", "admitted", "stopped", "superseded"], to: "admitted" },
  quiesce: { from: ["admitted"], to: "stopped", settledIn: ["absent", "stopped", "superseded"] },
});

const receiptError = (cause: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "runtimeShutdown",
    message: "Failed to read or update the managed runtime shutdown receipt.",
    remediation: "Verify the provider-lando plugin state directory is writable, then retry.",
    cause,
  });

export const openRuntimeShutdown = (stateStore: PluginStateStore) =>
  stateStore.open({
    key: RUNTIME_SHUTDOWN_KEY,
    schema: RuntimeShutdownReceipt,
    version: RUNTIME_SHUTDOWN_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: "discard",
  });

export const makeRuntimeShutdownStore = Effect.fnUntraced(function* (
  stateStore: PluginStateStore,
  bootIdReader: () => Effect.Effect<string, unknown> = readLinuxBootId,
) {
  const bucket = yield* openRuntimeShutdown(stateStore).pipe(mapFailures(receiptError));
  return {
    read: bucket.get,
    admit: Effect.gen(function* () {
      const bootId = yield* bootIdReader().pipe(mapFailures(receiptError));
      const generation = yield* Effect.sync(randomUUID);
      yield* bucket
        .transition({
          transitions: shutdownTransitions,
          operation: "admit",
          state: (current) => current?.state ?? "absent",
          next: () => ({ generation, bootId, state: "admitted" }),
          illegal: receiptError,
        })
        .pipe(mapFailures(receiptError));
    }),
    quiesce: (generation: string) =>
      bucket
        .transition({
          transitions: shutdownTransitions,
          operation: "quiesce",
          state: (current) =>
            current === null ? "absent" : current.generation === generation ? current.state : "superseded",
          next: (_to, current) => (current === null ? null : { ...current, state: "stopped" }),
          illegal: receiptError,
        })
        .pipe(mapFailures(receiptError), Effect.asVoid),
  };
});

export type RuntimeShutdownStore = Effect.Success<ReturnType<typeof makeRuntimeShutdownStore>>;
