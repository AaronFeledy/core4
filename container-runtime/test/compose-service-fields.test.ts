import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { renderCompose } from "../src/podman/compose.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"),
  source: "container-runtime/compose-service-fields.test.ts",
  runtime: 4 as const,
};

const planWith = (extensions: Record<string, unknown>, appExtensions: Record<string, unknown>): AppPlan => {
  const service: ServicePlan = {
    name: serviceName,
    type: "web",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions,
  };
  return {
    id: AppId.make("compose-service-fields"),
    name: "Compose Service Fields",
    slug: "compose-service-fields",
    root: AbsolutePath.make("/srv/apps/compose-service-fields"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: appExtensions,
  };
};

describe("Podman Compose service field realization", () => {
  test("Given user labels, When rendering, Then they merge with the reserved Lando labels", () => {
    // Given
    const plan = planWith({ compose: { labels: { "example.com/role": "web" } } }, {});

    // When
    const content = renderCompose(plan, ctx);

    // Then: `labels` is a declared-supported service field, so it must be realized, not dropped.
    expect(content).toContain('    labels:\n      dev.lando.app: "compose-service-fields"\n');
    expect(content).toContain('      dev.lando.service: "web"\n');
    expect(content).toContain('      example.com/role: "web"\n');
  });

  test("Given a reserved label key, When rendering, Then the Lando value wins over the user value", () => {
    // Given
    const plan = planWith({ compose: { labels: { "dev.lando.app": "user-value" } } }, {});

    // When
    const content = renderCompose(plan, ctx);

    // Then
    expect(content).toContain('      dev.lando.app: "compose-service-fields"\n');
    expect(content).not.toContain('"user-value"');
  });

  test("Given a config grant, When rendering, Then it becomes a read-only bind, not a compose configs block", () => {
    // Given
    const plan = planWith(
      { compose: { configs: [{ source: "phpini", target: "/usr/local/etc/php/conf.d/zz.ini" }] } },
      { compose: { configs: { phpini: { file: "./php.ini" } } } },
    );

    // When
    const content = renderCompose(plan, ctx);

    // Then: `configs` is declared supported at both service and project level via bind realization.
    expect(content).toContain(
      '      - "/srv/apps/compose-service-fields/php.ini:/usr/local/etc/php/conf.d/zz.ini:ro"\n',
    );
    expect(content).not.toContain("configs:");
  });

  test("Given a plan with no service extensions, When rendering, Then no unsupported service fields appear", () => {
    // Given
    const plan = planWith({}, {});

    // When
    const content = renderCompose(plan, ctx);

    // Then
    expect(content).not.toContain("deploy:");
    expect(content).not.toContain("secrets:");
    expect(content).not.toContain("configs:");
  });
});
