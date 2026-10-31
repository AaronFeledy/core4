import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { minioServiceType } from "../src/services/minio.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const plan = (artifact: Record<string, unknown>) =>
  composeServicePlan({
    serviceType: minioServiceType,
    service: Schema.decodeUnknownSync(ServiceConfig)({ type: "minio", endpoints: [], ...artifact }),
    appRoot: "/srv/apps/myapp",
    serviceName: "storage",
    metadata: { runtime: 4, resolvedAt: "2026-10-30T00:00:00Z", source: "minio-artifact" },
  });

test.each([{}, { image: "   " }, { build: { artifact: ["echo not-an-artifact"] } }])(
  "rejects missing effective artifact intent %j",
  async (artifact) => {
    // Given / When / Then
    await expect(plan(artifact)).rejects.toMatchObject({
      _tag: "ServiceFeatureError",
      issues: [expect.objectContaining({ path: ["image"], suggestion: expect.any(String) })],
    });
  },
);

test.each([{}, { image: "   " }])(
  "Compose build does not invent a placeholder image artifact %j",
  async (image) => {
    // Given / When
    const result = await plan({ ...image, build: { context: "." } });
    // Then the generic authored build owner, not this feature, supplies the artifact.
    expect(result.artifact).toBeUndefined();
  },
);
