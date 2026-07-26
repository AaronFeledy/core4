import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const appRoot = mkdtempSync(join(tmpdir(), "lando-compose-precedence-"));
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

test("prefers an authored Lando mount over a Compose volume at the same target", async () => {
  // Given
  const service = {
    type: "compose",
    image: "alpine:3",
    appMount: false,
    mounts: [{ source: "./a", target: "/x" }],
    volumes: ["./b:/x"],
  };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.mounts.map((mount) => ({ ...mount, target: String(mount.target) }))).toEqual([
    {
      type: "bind",
      source: resolve(appRoot, "a"),
      target: "/x",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("suppresses Compose storage at an authored Lando storage target", async () => {
  // Given
  const service = {
    type: "compose",
    image: "alpine:3",
    appMount: false,
    storage: [{ store: "s", target: "/y" }],
    volumes: [{ type: "volume", source: "v", target: "/y", volume: { subpath: "suppressed" } }],
  };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.storage).toEqual([]);
  expect(plan.storage.some((entry) => entry.store === "us469-v")).toBe(false);
  expect(plan.extensions?.compose).toBeUndefined();
});

test("suppresses a Compose volume at the active app mount target", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", volumes: ["./x:/app"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.mounts.map((mount) => ({ ...mount, target: String(mount.target) }))).toEqual([
    { type: "bind", source: appRoot, target: "/app", readOnly: false, realization: "passthrough" },
  ]);
});

test("applies a Compose volume when the app mount is disabled", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", appMount: false, volumes: ["./x:/app"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.mounts.map((mount) => ({ ...mount, target: String(mount.target) }))).toEqual([
    {
      type: "bind",
      source: resolve(appRoot, "x"),
      target: "/app",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("keeps exact-target precedence from suppressing descendant targets", async () => {
  // Given
  const service = {
    type: "compose",
    image: "alpine:3",
    appMount: false,
    mounts: [{ source: "./a", target: "/app" }],
    volumes: ["./w:/app/web"],
  };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.mounts.map((mount) => ({ ...mount, target: String(mount.target) }))).toEqual([
    {
      type: "bind",
      source: resolve(appRoot, "a"),
      target: "/app",
      readOnly: false,
      realization: "passthrough",
    },
    {
      type: "bind",
      source: resolve(appRoot, "w"),
      target: "/app/web",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});
