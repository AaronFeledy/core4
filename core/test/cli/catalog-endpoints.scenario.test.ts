import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deserialize } from "node:v8";
import { Schema } from "effect";
import { stringify } from "yaml";

import { APP_PLAN_CACHE_HEADER_BYTES } from "@lando/engine/cache/app-plan";
import { appPlanCachePath } from "@lando/engine/cache/paths";
import { AppPlan, ServiceName } from "@lando/sdk/schema";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const name = "catalog-endpoint-intent";
const endpoint = (protocol: "http" | "tcp", port: number, name: string) => ({
  _tag: "internal" as const,
  protocol,
  port,
  name,
});

const refresh = async (root: string) => {
  const child = Bun.spawn([process.execPath, cli, "app:cache:refresh", "--format=json"], {
    cwd: root,
    env: {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_PROVIDER: "lando",
      LANDO_TELEMETRY: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

test("source cache refresh preserves authored catalog endpoints, layer merging, and proxy backends", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-catalog-endpoints-")));
  const cacheRoot = join(root, "cache");
  const cache = endpoint("tcp", 6380, "cache");
  const fpm = endpoint("tcp", 9070, "fpm");
  const http = endpoint("http", 8080, "browser");
  const metrics = endpoint("tcp", 9090, "metrics");
  try {
    await Bun.write(
      join(root, ".lando.dist.yml"),
      stringify({
        services: { web: { endpoints: [endpoint("http", 80, "browser"), metrics] } },
      }),
    );
    await Bun.write(
      join(root, ".lando.yml"),
      stringify({
        name,
        services: {
          cache: { type: "redis", port: 6380, endpoints: [cache] },
          php: { type: "php:8.3", via: "fpm", port: 9070, endpoints: [fpm] },
          web: { type: "nginx", backend: "php", port: 8080, endpoints: [http] },
          hidden: { type: "nginx", endpoints: [] },
          inbox: { type: "mailpit", endpoints: [], mailFrom: false },
          queue: { type: "rabbitmq", endpoints: [endpoint("http", 15672, "dashboard")] },
        },
        proxy: { web: [{ hostname: "authored.lndo.site", endpoint: "browser" }] },
      }),
    );
    // When
    const { exitCode, stdout, stderr } = await refresh(root);
    // Then
    expect({ exitCode, stderr: exitCode === 0 ? "" : stderr, stdout: exitCode === 0 ? "" : stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "",
    });
    const bytes = await Bun.file(appPlanCachePath(cacheRoot, name, root)).bytes();
    const { plan } = Schema.decodeUnknownSync(Schema.Struct({ plan: AppPlan }))(
      deserialize(bytes.subarray(APP_PLAN_CACHE_HEADER_BYTES)),
    );
    expect(plan.services[ServiceName.make("cache")]?.endpoints).toEqual([cache]);
    expect(plan.services[ServiceName.make("php")]?.endpoints).toEqual([fpm]);
    expect(plan.services[ServiceName.make("web")]?.endpoints).toEqual([http, metrics]);
    expect(plan.services[ServiceName.make("hidden")]?.endpoints).toEqual([]);
    expect(plan.services[ServiceName.make("inbox")]?.endpoints).toEqual([]);
    expect(plan.services[ServiceName.make("inbox")]?.healthcheck?.command).toEqual(["/mailpit", "readyz"]);
    expect(plan.services[ServiceName.make("queue")]?.endpoints).toEqual([
      endpoint("http", 15672, "dashboard"),
    ]);
    expect(plan.routes.find((route) => route.hostname === "authored.lndo.site")?.backend).toEqual({
      service: ServiceName.make("web"),
      protocol: "http",
      port: 8080,
    });
    expect(plan.routes.filter((route) => ["hidden", "inbox"].includes(route.service))).toEqual([]);
    expect(plan.services[ServiceName.make("web")]?.command).toEqual(
      expect.arrayContaining([expect.stringContaining("fastcgi_pass php:9070;")]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("source cache refresh rejects routes to explicitly removed catalog endpoints", async () => {
  // Given
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-catalog-endpoints-error-")));
  try {
    await Bun.write(
      join(root, ".lando.yml"),
      stringify({
        name,
        services: { web: { type: "nginx", endpoints: [] } },
        proxy: { web: [{ hostname: "removed.lndo.site", endpoint: 80 }] },
      }),
    );
    // When
    const { exitCode, stdout } = await refresh(root);
    // Then
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      error: { _tag: "LandofileValidationError" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
