import { expect, test } from "bun:test";
import { makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import { makeUnavailableRouter } from "@lando/engine/subsystems/proxy/api";
import { ProxyError, ProxySetupError } from "@lando/sdk/errors";
import type { ProxyConfig } from "@lando/sdk/schema";
import { RouterService, type RouterServiceShape } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect, Result } from "effect";
import { runProxySetupStep } from "../../src/cli/command-specs/meta/setup-service-steps.ts";
import { makeSetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";

const noHostChanges = makeHostChangeApplier({ proposals: [], approved: new Set(), redact: String }).applier;

test.each([["--yes"], ["--no-interactive"], []])(
  "hands router setup the run's host changes and never its own consent for %j",
  async (...argv) => {
    // Given: a parsed setup invocation and an in-memory router.
    const configs: ProxyConfig[] = [];
    const options: Parameters<RouterServiceShape["setup"]>[1][] = [];
    const router = RouterService.of({
      ...makeTestRouterService(),
      setup: (config: ProxyConfig, setupOptions: Parameters<RouterServiceShape["setup"]>[1]) =>
        Effect.sync(() => {
          configs.push(config);
          options.push(setupOptions);
        }),
    });
    const input = compiledCommandInputFromArgv("meta:setup", argv);

    // When: setup runs its router step without touching the host.
    await Effect.runPromise(
      runProxySetupStep(input, makeSetupReadinessRecorder(undefined, "lando"), noHostChanges).pipe(
        Effect.provideService(RouterService, router),
      ),
    );

    // Then: consent was decided with the rest of the plan; the router only applies approvals.
    expect(options).toEqual([{ intent: "configure", hostChanges: noHostChanges, reacquirePorts: true }]);
    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toHaveProperty("reacquirePorts");
  },
);

test("#2138 reports the router selection failure when no router can be selected", async () => {
  // Given: a runtime whose configured router is not installed.
  const reason = new ProxyError({
    message: "Router service missing is not installed.",
    proxyId: "missing",
    remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
  });

  // When: setup runs its router step.
  const result = await Effect.runPromise(
    runProxySetupStep({ flags: {} }, makeSetupReadinessRecorder(undefined, "lando"), noHostChanges).pipe(
      Effect.provideService(RouterService, makeUnavailableRouter(reason)),
      Effect.result,
    ),
  );

  // Then: setup fails with the selection message and its remediation.
  expect(result).toEqual(
    Result.fail(
      new ProxySetupError({ message: reason.message, proxyId: "missing", remediation: reason.remediation }),
    ),
  );
});
