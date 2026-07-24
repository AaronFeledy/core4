import { expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

test("resolves an authored relative bind mount into the Compose service plan", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: {
      worker: {
        type: "compose",
        image: "traefik:v3.3",
        appMount: false,
        mounts: [
          {
            type: "bind",
            source: "./proxy-traefik/dynamic",
            target: "/etc/traefik/dynamic",
            readOnly: false,
          },
        ],
      },
    },
  });
  const service = landofile.services?.[ServiceName.make("worker")];
  if (service === undefined) throw new Error("worker service missing");

  // When
  const plan = await composeServicePlan({
    serviceType: composeServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    metadata: {
      resolvedAt: "2026-05-18T08:00:00Z",
      source: "/srv/apps/myapp/.lando.yml",
      runtime: 4,
    },
    serviceName: "worker",
    featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
  });

  // Then
  expect(plan.mounts).toEqual([
    {
      type: "bind",
      source: "/srv/apps/myapp/proxy-traefik/dynamic",
      target: "/etc/traefik/dynamic",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});

test("accepts a Windows drive-letter bind mount short syntax", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: {
      worker: {
        type: "compose",
        image: "traefik:v3.3",
        appMount: false,
        mounts: ["C:\\host\\dynamic:/etc/traefik/dynamic:ro"],
      },
    },
  });
  const service = landofile.services?.[ServiceName.make("worker")];
  if (service === undefined) throw new Error("worker service missing");

  // When
  const plan = await composeServicePlan({
    serviceType: composeServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    metadata: { resolvedAt: "2026-05-18T08:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
    serviceName: "worker",
    featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
  });

  // Then
  expect(plan.mounts).toEqual([
    {
      type: "bind",
      source: "C:\\host\\dynamic",
      target: "/etc/traefik/dynamic",
      readOnly: true,
      realization: "passthrough",
    },
  ]);
});

test("accepts a forward-slash Windows drive-letter bind mount short syntax", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    services: {
      worker: {
        type: "compose",
        image: "traefik:v3.3",
        appMount: false,
        mounts: ["C:/host/dynamic:/etc/traefik/dynamic"],
      },
    },
  });
  const service = landofile.services?.[ServiceName.make("worker")];
  if (service === undefined) throw new Error("worker service missing");

  // When
  const plan = await composeServicePlan({
    serviceType: composeServiceType,
    service,
    appRoot: "/srv/apps/myapp",
    metadata: { resolvedAt: "2026-05-18T08:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
    serviceName: "worker",
    featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
  });

  // Then
  expect(plan.mounts).toEqual([
    {
      type: "bind",
      source: "C:/host/dynamic",
      target: "/etc/traefik/dynamic",
      readOnly: false,
      realization: "passthrough",
    },
  ]);
});
