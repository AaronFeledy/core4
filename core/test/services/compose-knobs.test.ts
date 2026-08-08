import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import {
  type ComposeKnobCapabilities,
  type ProviderCapabilities,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  collectComposeKnobs,
  findUnsupportedComposeKnob,
  mergeComposeKnobs,
} from "@lando/engine/services/compose-knobs";

type ComposeCapabilityView = Pick<ProviderCapabilities, "composeSpec" | "composeKnobs">;

const servicePlan = (name: string, compose?: Record<string, unknown>): ServicePlan => ({
  name: ServiceName.make(name),
  type: "compose",
  provider: ProviderId.make("test"),
  primary: name === "web",
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00.000Z"),
    source: "compose-knobs.test",
    runtime: 4,
  },
  extensions: compose === undefined ? {} : { compose },
});

const capabilities = (
  composeSpec: ProviderCapabilities["composeSpec"],
  composeKnobs?: ComposeKnobCapabilities,
): ComposeCapabilityView => (composeKnobs === undefined ? { composeSpec } : { composeSpec, composeKnobs });

describe("Compose runtime knobs", () => {
  test("Given existing Compose extensions, when authored knobs are merged, then every existing writer survives", () => {
    // Given
    const plan = servicePlan("web", {
      labels: { "io.lando.role": "appserver" },
      healthcheck: { start_interval: "5s" },
      depends_on: { database: { restart: true } },
    });
    const serviceConfig: ServiceConfig = {
      restart: "unless-stopped",
      read_only: true,
      deploy: { resources: { limits: { memory: 67_108_864 } } },
    };

    // When
    const merged = mergeComposeKnobs(plan, serviceConfig);

    // Then
    expect(merged.extensions.compose).toEqual({
      labels: { "io.lando.role": "appserver" },
      healthcheck: { start_interval: "5s" },
      depends_on: { database: { restart: true } },
      restart: "unless-stopped",
      read_only: true,
      deploy: { resources: { limits: { memory: 67_108_864 } } },
    });
  });

  test("Given authored and injected tmpfs entries, when knobs are merged, then every entry is preserved", () => {
    // Given
    const plan = servicePlan("web", { tmpfs: ["/run", "/plugin-cache"] });
    const serviceConfig: ServiceConfig = { tmpfs: ["/authored-cache", "/run"] };

    // When
    const merged = mergeComposeKnobs(plan, serviceConfig);

    // Then
    expect(merged.extensions.compose).toEqual({
      tmpfs: ["/run", "/plugin-cache", "/authored-cache", "/run"],
    });
  });

  test("Given knobs only in final extensions, when uses are collected, then injected knobs are capability-gated", () => {
    // Given
    const services = {
      web: servicePlan("web", {
        tmpfs: ["/run"],
        deploy: { resources: { reservations: { memory: 33_554_432 } } },
      }),
    };

    // When
    const uses = collectComposeKnobs(services);

    // Then
    expect(uses).toEqual([
      { service: "web", key: "tmpfs" },
      { service: "web", key: "deploy.resources" },
    ]);
  });

  test("Given shuffled unsupported knobs, when support is checked repeatedly, then the first failure is stable", () => {
    // Given
    const alphaForward = servicePlan("alpha", {
      pull_policy: "always",
      cap_drop: ["NET_ADMIN"],
    });
    const alphaReverse = servicePlan("alpha", {
      cap_drop: ["NET_ADMIN"],
      pull_policy: "always",
    });
    const middle = servicePlan("middle", { devices: [{ source: "/dev/fuse" }] });
    const zeta = servicePlan("zeta", { gpus: "all", restart: "always" });
    const shuffledServices = [
      { zeta, alpha: alphaForward, middle },
      { middle, zeta, alpha: alphaReverse },
      { alpha: alphaForward, middle, zeta },
    ];
    const shuffledUses = shuffledServices.flatMap((services) => {
      const uses = collectComposeKnobs(services);
      return [uses, [...uses].reverse()];
    });

    // When
    const failures = shuffledUses.flatMap((uses) => [
      findUnsupportedComposeKnob(uses, capabilities("native", { supported: ["restart"] })),
      findUnsupportedComposeKnob(uses, capabilities("native", { supported: ["restart"] })),
    ]);

    // Then
    expect(failures).toEqual(
      Array.from({ length: shuffledUses.length * 2 }, () => ({
        service: "alpha",
        key: "cap_drop",
      })),
    );
  });

  test("Given the fail-closed capability matrix, when one knob is checked, then only native exact support accepts it", () => {
    // Given
    const uses = collectComposeKnobs({ web: servicePlan("web", { tmpfs: ["/run"] }) });

    // When
    const results = [
      findUnsupportedComposeKnob(uses, capabilities("native")),
      findUnsupportedComposeKnob(uses, capabilities("portable", { supported: ["tmpfs"] })),
      findUnsupportedComposeKnob(uses, capabilities("native", { supported: ["tmpfs"] })),
    ];

    // Then
    expect(results).toEqual([{ service: "web", key: "tmpfs" }, { service: "web", key: "tmpfs" }, undefined]);
  });
});
