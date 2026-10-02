import { runtimeProviderService } from "@lando/engine/runtime/bootstrap-layer-support";
import { ProviderInternalError } from "@lando/sdk/errors";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { runAgentRelayWorkerProcess } from "../../../src/cli/agent-relay/worker-runtime";

const provider = {
  ...runtimeProviderService,
  openAgentSocketBridge: () =>
    Effect.fail(
      new ProviderInternalError({
        providerId: "docker",
        operation: "bridge",
        message: "sensitive-provider-diagnostic",
      }),
    ),
};
void runAgentRelayWorkerProcess({
  runtime: Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  }),
}).catch(() => {
  process.exitCode = 1;
});
