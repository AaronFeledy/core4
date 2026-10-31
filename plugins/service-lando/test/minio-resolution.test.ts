import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { Effect, Schema } from "effect";
import { MINIO_FEATURE_ID, minioServiceType } from "../src/services/minio.ts";

const resolve = (service: Record<string, unknown>) =>
  Effect.runPromise(
    minioServiceType.resolve({
      name: "storage",
      service: Schema.decodeUnknownSync(ServiceConfig)(service),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata: { resolvedAt: "2026-08-18T00:00:00Z", source: "minio-resolution", runtime: 4 },
    }),
  );

test("resolves tooling, feature, and catalog schema before effective artifact validation", async () => {
  // Given / When
  const resolution = await resolve({ type: "minio" });
  // Then
  expect(resolution.base).toBe("lando");
  expect(resolution.features).toEqual([{ id: MINIO_FEATURE_ID, config: { consolePort: 9001 } }]);
  expect(resolution.tooling?.mc).toEqual({ service: "storage", cmd: "mc" });
  expect(minioServiceType.schema).toBe(MinIOServiceConfig);
});

test("preserves authored routes", async () => {
  // Given / When
  const resolution = await resolve({
    type: "minio",
    routes: [{ hostname: "files.example.test", scheme: "https", endpoint: 9001 }],
  });
  // Then
  expect(resolution.normalizedConfig.routes).toEqual([
    { hostname: "files.example.test", scheme: "https", endpoint: 9001 },
  ]);
});
