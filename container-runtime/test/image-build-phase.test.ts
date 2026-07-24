import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { type ContainerBuildHttpRequest, buildContainerArtifact } from "@lando/container-runtime/image-build";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("phase-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-24T00:00:00Z"),
  source: "image-build-phase.test.ts",
  runtime: 4 as const,
};

const collect = async (input: AsyncIterable<Uint8Array> | undefined): Promise<string> => {
  if (input === undefined) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
};

test("derived Dockerfiles contain only build-phase steps", async () => {
  // Given
  const service: ServicePlan = {
    name: serviceName,
    type: "php:8.2",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "php:8.2-apache-bookworm" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [
          { id: "compile", phase: "build", command: ["echo", "build-only"] },
          { id: "install", phase: "app", command: ["echo", "app-only"] },
        ],
      },
    },
  };
  const plan: AppPlan = {
    id: appId,
    name: "Phase Build App",
    slug: "phase-build-app",
    root: AbsolutePath.make("/tmp/phase-build-app"),
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const dockerfiles: string[] = [];
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        if (request.method === "POST") dockerfiles.push(await collect(request.stdin));
        return { status: 200, body: request.method === "GET" ? "{}" : "" };
      }),
  };

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      { app: appId, service: serviceName, plan, buildKey: "phase-key" },
      { providerId, api },
    ),
  );

  // Then
  expect(dockerfiles).toHaveLength(1);
  expect(dockerfiles[0]).toContain('RUN ["echo","build-only"]');
  expect(dockerfiles[0]).not.toContain("app-only");
});
