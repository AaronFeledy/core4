import { expect, test } from "bun:test";

import { DateTime } from "effect";

import { PortablePath, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { serviceWithArtifact } from "../../src/services/build-artifact-runner.ts";

test("retains the CA bundle mount for an app-phase reserved step after another artifact build succeeds", () => {
  // Given
  const providerId = ProviderId.make("test");
  const bundleMount = {
    type: "bind" as const,
    source: "/host/ca-bundle.pem",
    target: PortablePath.make("/etc/lando/certs/ca-bundle.pem"),
    readOnly: true,
    realization: "passthrough" as const,
  };
  const service: ServicePlan = {
    name: ServiceName.make("web"),
    type: "node",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "debian:12" },
    environment: {},
    mounts: [bundleMount],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: {
      resolvedAt: DateTime.unsafeMake("2026-07-30T00:00:00.000Z"),
      source: "build-artifact-runner.test",
      runtime: 4,
    },
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [
          {
            id: "lando.security:trust-store",
            phase: "app",
            command: "app-only",
            caFiles: [{ path: "/host/corp.pem", digest: "a".repeat(64), archiveName: "corp.crt" }],
          },
          { id: "third-party:image-build", phase: "build", command: "build-image" },
        ],
      },
    },
  };

  // When
  const built = serviceWithArtifact(service, { providerId, ref: "debian:12-built" });

  // Then
  expect(built.mounts).toEqual([bundleMount]);
});
