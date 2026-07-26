import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const appRoot = mkdtempSync(join(tmpdir(), "lando-compose-volumes-"));
afterAll(() => rmSync(appRoot, { recursive: true, force: true }));

const planService = async (serviceConfig: unknown) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "us469",
    services: { web: serviceConfig },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType: composeServiceType,
    service,
    appRoot,
    appName: "us469",
    metadata: { resolvedAt: "2026-07-26T08:00:00Z", source: join(appRoot, ".lando.yml"), runtime: 4 },
    serviceName: "web",
    featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
  });
};

test("normalizes a Compose bind volume into a resolved mount", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", appMount: false, volumes: ["./src:/app2"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.mounts.map((mount) => ({ ...mount, target: String(mount.target) }))).toEqual([
    {
      type: "bind",
      source: resolve(appRoot, "src"),
      target: "/app2",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
  expect(plan.storage).toEqual([]);
});

test("normalizes a named Compose volume into app-scoped storage", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", appMount: false, volumes: ["db:/data"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.storage.map((storage) => ({ ...storage, target: String(storage.target) }))).toEqual([
    { store: "us469-db", target: "/data", readOnly: false },
  ]);
});

test("assigns a deterministic store to an anonymous Compose volume", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", appMount: false, volumes: ["/var/lib/mysql"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.storage.map((storage) => ({ ...storage, target: String(storage.target) }))).toEqual([
    { store: "us469-web-var-lib-mysql", target: "/var/lib/mysql", readOnly: false },
  ]);
});

test("preserves Compose tmpfs in the compose extension only", async () => {
  // Given
  const service = {
    type: "compose",
    image: "alpine:3",
    appMount: false,
    volumes: [{ type: "tmpfs", target: "/cache", read_only: true, tmpfs: { size: "64m", mode: 448 } }],
  };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.extensions?.compose).toEqual({
    tmpfs: [{ target: "/cache", read_only: true, size: "64m", mode: 448 }],
  });
  expect(plan.mounts).toEqual([]);
  expect(plan.storage).toEqual([]);
});

test("keeps Lando tmpfs mounts on the MountPlan path", async () => {
  // Given
  const service = {
    type: "compose",
    image: "alpine:3",
    appMount: false,
    mounts: [{ type: "tmpfs", target: "/run/cache" }],
  };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.mounts.map((mount) => ({ ...mount, target: String(mount.target) }))).toEqual([
    { type: "tmpfs", target: "/run/cache", readOnly: false, realization: "passthrough" },
  ]);
});
