import {
  type ListenerObservation,
  type ServicePlan,
  effectiveReadiness,
  groupLogicalEndpoints,
} from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk } from "@lando/sdk/services";
import { Cause, Duration, Effect, type Scope, Stream } from "effect";
import { classifyTcpListeners, parseTcpListeners } from "./listener-parser.ts";
import { serviceProbeListener } from "./service-probe.ts";

export const LISTENER_COMMAND = {
  command: ["cat", "/proc/net/tcp", "/proc/net/tcp6"],
  raw: true,
} satisfies CommandSpec;
export const LISTENER_MAX_BYTES = 128 * 1024;

export const expectedTcpListener = (service: ServicePlan) => {
  const probe = effectiveReadiness(service);
  if (probe?.executionTarget === "host") return undefined;
  const listener = probe === undefined ? undefined : serviceProbeListener(probe);
  if (listener !== undefined)
    return listener.transport === "tcp"
      ? {
          service: String(service.name),
          port: listener.port,
          transport: "tcp" as const,
          basis: "probe-target" as const,
        }
      : undefined;
  const primaries = groupLogicalEndpoints(service.endpoints).filter((endpoint) => endpoint.primary);
  const [primary] = primaries;
  return primaries.length === 1 && primary?.transport === "tcp"
    ? {
        service: String(service.name),
        port: primary.port,
        transport: "tcp" as const,
        basis: "primary-endpoint" as const,
      }
    : undefined;
};

/** Best effort only; cancellation still belongs to the caller. Nonzero cat may mean tcp6 is absent. */
export const observeTcpListener = <E, R>(
  service: ServicePlan,
  execute: (command: CommandSpec) => Stream.Stream<ExecChunk, E, R>,
): Effect.Effect<ListenerObservation | undefined, never, Exclude<R, Scope.Scope>> => {
  const expected = expectedTcpListener(service);
  if (expected === undefined) return Effect.succeed(undefined);
  return Effect.suspend(() => {
    const buffer = new Uint8Array(LISTENER_MAX_BYTES);
    let length = 0;
    let overflow = false;
    let terminal = false;
    return execute(LISTENER_COMMAND).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          if ("exitCode" in chunk) {
            terminal = true;
            return;
          }
          if (chunk.kind !== "stdout" || overflow) return;
          if (chunk.chunk.length > buffer.length - length) {
            overflow = true;
            return;
          }
          buffer.set(chunk.chunk, length);
          length += chunk.chunk.length;
        }),
      ),
      Effect.map(() => {
        if (overflow || !terminal) return undefined;
        const bindings = parseTcpListeners(new TextDecoder().decode(buffer.subarray(0, length)));
        return bindings === undefined ? undefined : classifyTcpListeners(expected, bindings);
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeout(Duration.seconds(2)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(undefined),
    ),
  );
};
