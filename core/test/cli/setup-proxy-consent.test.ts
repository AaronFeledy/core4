import { expect, test } from "bun:test";
import { Effect } from "effect";

import type { ProxyConfig } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { runProxySetupStep } from "../../src/cli/command-specs/meta/setup-service-steps.ts";
import { makeSetupReadinessRecorder } from "../../src/cli/command-specs/meta/setup-steps.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/compiled-input.ts";

test.each([{ argv: ["--yes"] }, { argv: ["--no-interactive"] }, { argv: ["--yes", "--no-interactive"] }])(
  "passes automatic consent to router setup for %j",
  async ({ argv }) => {
    // Given: a parsed setup invocation and an in-memory router.
    const configs: ProxyConfig[] = [];
    const router = {
      ...makeTestRouterService(),
      setup: (config: ProxyConfig) => Effect.sync(() => void configs.push(config)),
    };
    const input = compiledCommandInputFromArgv("meta:setup", argv);

    // When: setup runs its router step without touching the host.
    await Effect.runPromise(
      runProxySetupStep(input, makeSetupReadinessRecorder(undefined, "lando")).pipe(
        Effect.provideService(RouterService, router),
      ),
    );

    // Then: the invocation grants automatic consent to the router.
    expect(configs).toEqual([expect.objectContaining({ autoApprove: true })]);
  },
);

test("preserves interactive consent when setup has no approval flags", async () => {
  // Given
  const configs: ProxyConfig[] = [];
  const router = {
    ...makeTestRouterService(),
    setup: (config: ProxyConfig) => Effect.sync(() => void configs.push(config)),
  };

  // When
  await Effect.runPromise(
    runProxySetupStep({ flags: {} }, makeSetupReadinessRecorder(undefined, "lando")).pipe(
      Effect.provideService(RouterService, router),
    ),
  );

  // Then
  expect(configs).toHaveLength(1);
  expect(configs[0]).not.toEqual(expect.objectContaining({ autoApprove: true }));
});
