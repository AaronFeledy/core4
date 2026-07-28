import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";

import {
  bringDown,
  bringUp,
  introspectProviderCapabilities,
  makePodmanApiClient,
} from "@lando/provider-lando";
import type { AppPlan } from "@lando/sdk/schema";

import { loadLandofileFile } from "../../../core/src/landofile/service.ts";
import { makePluginRegistryLive } from "../../../core/src/plugins/registry.ts";
import { AppPlanner, AppPlannerLive } from "../../../core/src/services/planner.ts";

const liveSocketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
const fixturesRoot = resolve(import.meta.dir, "../../../core/test/fixtures/compose/corpus");
const plannerLayer = AppPlannerLive.pipe(Layer.provide(makePluginRegistryLive({ app: false, user: false })));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const arrayField = (value: unknown, key: string): readonly unknown[] => {
  const candidate = field(value, key);
  return Array.isArray(candidate) ? candidate : [];
};

interface FixtureCase {
  readonly id: string;
  readonly file: string;
  readonly service: string;
  readonly assertInspect: (inspect: unknown, appRoot: string) => void;
}

const fixtures = [
  {
    id: "long-form-mounts-ports",
    file: "long-form-mounts-ports.compose.yaml",
    service: "web",
    assertInspect: (inspect: unknown, appRoot: string) => {
      const hostConfig = field(inspect, "HostConfig");
      expect(field(field(hostConfig, "PortBindings"), "8080/tcp")).toEqual([
        { HostIp: "127.0.0.1", HostPort: "8443" },
      ]);

      const mounts = arrayField(inspect, "Mounts");
      const bind = mounts.find((mount) => field(mount, "Destination") === "/workspace/src");
      expect(field(bind, "Type")).toBe("bind");
      expect(field(bind, "Source")).toBe(join(appRoot, "src"));
      expect(field(bind, "RW")).toBe(false);

      const volume = mounts.find((mount) => field(mount, "Destination") === "/var/cache/app");
      expect(field(volume, "Type")).toBe("volume");
      expect(field(volume, "RW")).toBe(true);

      const tmpfs = String(field(field(hostConfig, "Tmpfs"), "/run/app"));
      expect(tmpfs).toContain("size=67108864");
      expect(tmpfs).toContain("mode=1770");
    },
  },
  {
    id: "healthcheck",
    file: "healthcheck.compose.yaml",
    service: "gateway",
    assertInspect: (inspect: unknown) => {
      const healthcheck = field(field(inspect, "Config"), "Healthcheck");
      expect(field(healthcheck, "Test")).toEqual([
        "CMD-SHELL",
        "curl --fail http://localhost:8080/health || exit 1",
      ]);
      expect(field(healthcheck, "Interval")).toBe(30_000_000_000);
      expect(field(healthcheck, "Timeout")).toBe(30_000_000_000);
      expect(field(healthcheck, "Retries")).toBe(5);
      expect(field(healthcheck, "StartPeriod")).toBe(90_000_000_000);
    },
  },
] satisfies readonly FixtureCase[];

const makeRunnableLandofile = (name: string, fixture: string): string =>
  `name: ${name}\nprovider: lando\n${fixture.replace(
    /^(\s*)image:.*$/mu,
    '$1image: node:22-alpine\n$1command: ["node", "-e", "setInterval(() => {}, 1000)"]',
  )}`;

const runFixture = async (fixture: FixtureCase): Promise<void> => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), `lando-compose-${fixture.id}-`)));
  const api = makePodmanApiClient(liveSocketPath);
  const liveRequest = api.request;
  if (liveRequest === undefined) throw new Error("live Podman client exposes no request transport");
  let plan: AppPlan | undefined;

  try {
    await mkdir(join(appRoot, "src"));
    const fixtureSource = await Bun.file(join(fixturesRoot, fixture.file)).text();
    const landofilePath = join(appRoot, ".lando.yml");
    await writeFile(landofilePath, makeRunnableLandofile(`compose-fixture-${fixture.id}`, fixtureSource));

    const landofile = await Effect.runPromise(loadLandofileFile(landofilePath));
    const capabilities = await Effect.runPromise(introspectProviderCapabilities(api));
    plan = await Effect.runPromise(
      AppPlanner.pipe(
        Effect.flatMap((planner) => planner.plan(landofile, capabilities)),
        Effect.provide(plannerLayer),
      ),
    );
    await Effect.runPromise(bringUp(plan, { podmanApi: api }));

    const containerName = `lando-${plan.slug}-${fixture.service}`;
    const response = await Effect.runPromise(
      liveRequest({ method: "GET", path: `/containers/${containerName}/json` }),
    );
    expect(response.status).toBe(200);
    const inspect: unknown = JSON.parse(response.body);
    fixture.assertInspect(inspect, appRoot);
  } finally {
    try {
      if (plan !== undefined) {
        await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api, volumes: true })));
      }
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  }
};

describe("provider-lando committed Compose fixtures (live)", () => {
  for (const fixture of fixtures) {
    test.skipIf(liveSocketPath.length === 0)(
      `Given the ${fixture.id} fixture, when production planning creates a live container, then inspect realizes its Compose intent`,
      () => runFixture(fixture),
      60_000,
    );
  }
});
