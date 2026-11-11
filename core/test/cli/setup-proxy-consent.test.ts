import { expect, test } from "bun:test";
import { Effect, Result } from "effect";

import { makeUnavailableRouter } from "@lando/engine/subsystems/proxy/api";
import { ProxyError, ProxySetupError } from "@lando/sdk/errors";

import type { ProxyConfig } from "@lando/sdk/schema";
import { RouterService, type RouterServiceShape } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { runProxySetupStep } from "../../src/cli/command-specs/meta/setup-service-steps.ts";
import { makeSetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";

test.each([{ argv: ["--yes"] }, { argv: ["--no-interactive"] }, { argv: ["--yes", "--no-interactive"] }])(
  "passes automatic consent to router setup for %j",
  async ({ argv }) => {
    // Given: a parsed setup invocation and an in-memory router.
    const configs: ProxyConfig[] = [];
    const approvals: Parameters<RouterServiceShape["setup"]>[1][] = [];
    const router = RouterService.of({
      ...makeTestRouterService(),
      setup: (config: ProxyConfig, options: Parameters<RouterServiceShape["setup"]>[1]) =>
        Effect.sync(() => {
          configs.push(config);
          approvals.push(options);
        }),
    });
    const input = compiledCommandInputFromArgv("meta:setup", argv);

    // When: setup runs its router step without touching the host.
    await Effect.runPromise(
      runProxySetupStep(input, makeSetupReadinessRecorder(undefined, "lando")).pipe(
        Effect.provideService(RouterService, router),
      ),
    );

    // Then: the invocation grants automatic consent to the router.
    expect(approvals).toEqual([{ intent: "configure", autoApprove: true, reacquirePorts: true }]);
    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toHaveProperty("autoApprove");
    expect(configs[0]).not.toHaveProperty("reacquirePorts");
  },
);

test("preserves interactive consent when setup has no approval flags", async () => {
  // Given
  const configs: ProxyConfig[] = [];
  const approvals: Parameters<RouterServiceShape["setup"]>[1][] = [];
  const router = RouterService.of({
    ...makeTestRouterService(),
    setup: (config: ProxyConfig, options: Parameters<RouterServiceShape["setup"]>[1]) =>
      Effect.sync(() => {
        configs.push(config);
        approvals.push(options);
      }),
  });

  // When
  await Effect.runPromise(
    runProxySetupStep({ flags: {} }, makeSetupReadinessRecorder(undefined, "lando")).pipe(
      Effect.provideService(RouterService, router),
    ),
  );

  // Then
  expect(configs).toHaveLength(1);
  expect(configs[0]).not.toHaveProperty("autoApprove");
  expect(approvals).toEqual([{ intent: "configure", autoApprove: false, reacquirePorts: true }]);
});

test("#2138 reports the router selection failure when no router can be selected", async () => {
  // Given: a runtime whose configured router is not installed.
  const reason = new ProxyError({
    message: "Router service missing is not installed.",
    proxyId: "missing",
    remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
  });

  // When: setup runs its router step.
  const result = await Effect.runPromise(
    runProxySetupStep({ flags: {} }, makeSetupReadinessRecorder(undefined, "lando")).pipe(
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
