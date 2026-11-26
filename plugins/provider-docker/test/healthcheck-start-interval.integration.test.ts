import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { resolveBuiltContainerHelperForTest } from "@lando/container-runtime/testing/exec-supervision";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeDockerApiClient, layer as providerLayer } from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type HealthcheckPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";

import { ownerOnlyFileAccess } from "./private-file-access.ts";

const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET || undefined;
const fixtureId = `health-start-interval-${crypto.randomUUID()}`;
const appId = AppId.make(fixtureId);
const providerId = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-23T00:00:00Z"),
  source: "provider-docker/healthcheck-start-interval.integration.test.ts",
  runtime: 4 as const,
};

// The #2600 shape: a passing check with a start interval, which must survive into the container.
const roundTrip = ServiceName.make("roundtrip");
// Fails until a marker exists, so the container stays `starting` and only the start interval paces it.
const cadence = ServiceName.make("cadence");

const service = (
  name: ServiceName,
  check: Pick<HealthcheckPlan, "command" | "intervalSeconds" | "startPeriodSeconds">,
  startInterval: string,
): ServicePlan => ({
  name,
  type: "compose",
  provider: providerId,
  primary: name === roundTrip,
  artifact: { kind: "ref", ref: "alpine:3.20" },
  command: ["sleep", "3600"],
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  healthcheck: { kind: "command", timeoutSeconds: 2, retries: 3, ...check },
  // Readiness off: apply must not wait on a check that fails by design.
  readiness: { kind: "none", intervalSeconds: 1, timeoutSeconds: 1, retries: 1 },
  metadata,
  extensions: { compose: { healthcheck: { start_interval: startInterval } } },
});

const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Health Start Interval",
  slug: fixtureId,
  root: AbsolutePath.make(join(tmpdir(), fixtureId)),
  provider: providerId,
  services: {
    [roundTrip]: service(roundTrip, { command: "true", intervalSeconds: 30, startPeriodSeconds: 10 }, "2s"),
    [cadence]: service(
      cadence,
      { command: "test -e /tmp/ready", intervalSeconds: 30, startPeriodSeconds: 60 },
      "1s",
    ),
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

interface HealthInspect {
  readonly Config?: { readonly Healthcheck?: { readonly StartInterval?: number } };
  readonly State?: {
    readonly Health?: { readonly Status?: string; readonly Log?: ReadonlyArray<unknown> | null };
  };
}

describe("docker healthcheck start_interval", () => {
  test.skipIf(dockerHost === undefined)(
    "Docker Engine API 1.44+ honors healthcheck start_interval",
    async () => {
      const api = makeDockerApiClient(dockerHost ?? "");
      const request = api.request;
      if (request === undefined) throw new TypeError("Expected a Docker request client");
      const inspect = async (name: ServiceName): Promise<HealthInspect> => {
        const response = await Effect.runPromise(
          request({ method: "GET", path: `/containers/${serviceContainerName(plan, name)}/json` }),
        );
        expect(response.status).toBe(200);
        return JSON.parse(response.body) as HealthInspect;
      };
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            providerLayer({
              platform: "linux",
              resolveContainerHelper: resolveBuiltContainerHelperForTest,
              dockerApi: api,
              appliedPlanState: makePluginStateStore(
                makeTestStateStore().service,
                AbsolutePath.make(join(tmpdir(), `docker-start-interval-${crypto.randomUUID()}`)),
                ownerOnlyFileAccess,
              ),
            }),
          ),
        ),
      );
      // The live endpoint declares the field only because it answers at API 1.44 or newer.
      expect(provider.capabilities.composePreservedPaths?.supported).toContain("healthcheck.start_interval");
      await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
      try {
        expect((await inspect(roundTrip)).Config?.Healthcheck?.StartInterval).toBe(2_000_000_000);

        // Time is the behavior under test: a 30-second interval logs no check within this window,
        // so three logged checks prove the one-second start interval paced them.
        const deadline = Date.now() + 8_000;
        let observed = await inspect(cadence);
        while ((observed.State?.Health?.Log?.length ?? 0) < 3 && Date.now() < deadline) {
          await Bun.sleep(250);
          observed = await inspect(cadence);
        }
        expect(observed.State?.Health?.Log?.length ?? 0).toBeGreaterThanOrEqual(3);
        expect(observed.State?.Health?.Status).toBe("starting");
      } finally {
        await Effect.runPromise(
          provider
            .bringDown({ app: appId }, { containers: "remove", volumes: true })
            .pipe(Effect.provide(makeTestStateStore().layer)),
        );
      }
    },
    120_000,
  );
});
