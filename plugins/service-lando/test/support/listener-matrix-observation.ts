import { expect } from "bun:test";
import { classifyTcpListeners, parseTcpListeners } from "@lando/container-runtime/listener-parser";
import { runProbe } from "@lando/sdk/probe";
import { PortNumber, ServiceName } from "@lando/sdk/schema";
import { Duration, Effect } from "effect";
import type { ListenerContract } from "../../src/services/_port-helpers.ts";
import type { ListenerApp } from "./listener-cli.ts";

export const observeMatrixListener = Effect.fnUntraced(function* (
  app: ListenerApp,
  target: { readonly contract: ListenerContract; readonly family: string; readonly port: number },
) {
  const { contract, family, port } = target;
  const allowed = new Set([port, ...(contract.reserved ?? []).map((entry) => entry.port)]);
  // These type-documented secondaries move with the primary rather than reserving a fixed port.
  if (family === "solr") allowed.add(port - 1000);
  if (family === "rabbitmq") allowed.add(port + 20000);
  // The reviewed OpenSearch image includes its performance-analyzer infrastructure agent.
  // This is not the application endpoint or the transport listener (9300 is contract-reserved).
  if (family === "opensearch") allowed.add(9600);

  const result = yield* runProbe(
    {
      id: `listener-matrix/${family}/${port}`,
      policy: { maxAttempts: 60, delay: Duration.seconds(1), timeout: Duration.seconds(90) },
    },
    Effect.gen(function* () {
      const stdout = yield* app.exec("subject", ["cat", "/proc/net/tcp", "/proc/net/tcp6"]);
      const bindings = parseTcpListeners(stdout);
      if (bindings === undefined)
        return yield* Effect.fail(new Error(`Listener observation unavailable for ${family}:${port}`));
      const observation = classifyTcpListeners(
        {
          service: ServiceName.make("subject"),
          port: PortNumber.make(port),
          basis: "primary-endpoint",
          transport: "tcp",
        },
        bindings,
      );
      if (observation.state !== "listening")
        return yield* Effect.fail(
          new Error(`${family}:${port} ${observation.state}: ${JSON.stringify(bindings)}`),
        );
      return bindings;
    }).pipe(Effect.timeout("15 seconds")),
  );
  if (result.outcome !== "green")
    return yield* Effect.fail(
      new Error(`Listener matrix probe exhausted for ${family}:${port}: ${String(result.lastError)}`),
    );
  // Re-read the complete table after convergence: classification intentionally caps its diagnostic list.
  const stdout = yield* app.exec("subject", ["cat", "/proc/net/tcp", "/proc/net/tcp6"]);
  const bindings = parseTcpListeners(stdout);
  if (bindings === undefined)
    return yield* Effect.fail(new Error(`Listener observation unavailable for ${family}:${port}`));
  expect(
    bindings.some((binding) => binding.port === port && !binding.loopback),
    stdout,
  ).toBe(true);
  expect(
    bindings.filter((binding) => !allowed.has(binding.port)),
    stdout,
  ).toEqual([]);
  if (port !== contract.port)
    expect(
      bindings.filter((binding) => binding.port === contract.port),
      stdout,
    ).toEqual([]);
});
