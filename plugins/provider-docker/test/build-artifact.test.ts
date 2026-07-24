import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import {
  type DockerApiClient,
  type DockerHttpRequest,
  dockerCapabilitiesForPlatform,
  makeRuntimeProvider,
} from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-12T00:00:00Z"),
  source: "provider-docker/build-artifact.test.ts",
  runtime: 4 as const,
};

const service = (
  artifact: ServicePlan["artifact"],
  extensions: ServicePlan["extensions"] = {},
): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions,
});

const plan = (servicePlan: ServicePlan): AppPlan => ({
  id: appId,
  name: "Build App",
  slug: "build-app",
  root: AbsolutePath.make("/tmp/build-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const collect = async (input: AsyncIterable<Uint8Array> | undefined): Promise<string> => {
  if (input === undefined) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
};

test("advertises artifactBuild for Docker", () => {
  expect(dockerCapabilitiesForPlatform("linux").artifactBuild).toBe(true);
});

test("buildArtifact sends Docker build requests for build specs", async () => {
  const context = await mkdtemp(join(tmpdir(), "lando-docker-build-"));
  try {
    await writeFile(join(context, "Containerfile"), "FROM alpine\n");
    const requests: DockerHttpRequest[] = [];
    const dockerApi: DockerApiClient = {
      info: Effect.succeed({ Architecture: "x86_64" }),
      request: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return request.method === "POST"
            ? { status: 200, body: '{"aux":{"Digest":"sha256:built"}}\n' }
            : { status: 200, body: '{"Id":"sha256:built"}' };
        }),
    };
    const provider = await Effect.runPromise(makeRuntimeProvider({ dockerApi, platform: "linux" }));
    const servicePlan = service({
      kind: "build",
      context: AbsolutePath.make(context),
      spec: PortablePath.make("Containerfile"),
      args: { NODE_ENV: "production" },
      target: "runtime",
    });

    const artifact = await Effect.runPromise(
      Effect.scoped(
        provider.buildArtifact({
          app: appId,
          service: serviceName,
          plan: plan(servicePlan),
          buildKey: "abc123",
        }),
      ),
    );

    expect(artifact).toEqual({ providerId, ref: "lando-build-docker-web-abc123", digest: "sha256:built" });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toContain("/build?t=lando-build-docker-web-abc123");
    expect(requests[0]?.path).toContain("dockerfile=Containerfile");
    expect(requests[0]?.path).toContain("target=runtime");
    expect(requests[0]?.path).toContain("buildargs=%7B%22NODE_ENV%22%3A%22production%22%7D");
    expect(requests[1]).toEqual({
      method: "GET",
      path: "/images/lando-build-docker-web-abc123/json",
    });
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("buildArtifact applies build steps after a context build", async () => {
  const context = await mkdtemp(join(tmpdir(), "lando-docker-derived-build-"));
  try {
    await writeFile(join(context, "Containerfile"), "FROM alpine AS runtime\n");
    const requests: DockerHttpRequest[] = [];
    const bodies: string[] = [];
    const dockerApi: DockerApiClient = {
      info: Effect.succeed({ Architecture: "x86_64" }),
      request: (request) =>
        Effect.promise(async () => {
          requests.push(request);
          bodies.push(await collect(request.stdin));
          return { status: 200, body: "" };
        }),
    };
    const provider = await Effect.runPromise(makeRuntimeProvider({ dockerApi, platform: "linux" }));
    const servicePlan = service(
      {
        kind: "build",
        context: AbsolutePath.make(context),
        spec: PortablePath.make("Containerfile"),
        target: "runtime",
      },
      {
        "@lando/core/service-features": {
          buildSteps: [
            { id: "redirect-mkdir", phase: "build", command: ["mkdir", "-p", "/logs"] },
            { id: "redirect", phase: "build", command: ["ln", "-sf", "/dev/stdout", "/logs/access.log"] },
          ],
        },
      },
    );

    await Effect.runPromise(
      Effect.scoped(
        provider.buildArtifact({
          app: appId,
          service: serviceName,
          plan: plan(servicePlan),
          buildKey: "derived-key",
        }),
      ),
    );

    expect(requests).toHaveLength(4);
    expect(requests[0]?.path).toContain("t=lando-build-docker-web-derived-key-base");
    expect(requests[0]?.path).toContain("target=runtime");
    expect(requests[1]).toEqual({
      method: "GET",
      path: "/images/lando-build-docker-web-derived-key-base/json",
    });
    expect(requests[2]?.path).toContain("t=lando-build-docker-web-derived-key");
    expect(requests[2]?.path).not.toContain("target=runtime");
    expect(requests[3]).toEqual({
      method: "GET",
      path: "/images/lando-build-docker-web-derived-key/json",
    });
    expect(bodies[2]).toContain("FROM lando-build-docker-web-derived-key-base");
    expect(bodies[2]).toContain(
      'RUN ["mkdir","-p","/logs"]\nRUN ["ln","-sf","/dev/stdout","/logs/access.log"]',
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("buildArtifact derives a Dockerfile for ref builds with build steps", async () => {
  let requestBody = "";
  const dockerApi: DockerApiClient = {
    info: Effect.succeed({ Architecture: "x86_64" }),
    request: (request) =>
      Effect.promise(async () => {
        if (request.method === "POST") requestBody = await collect(request.stdin);
        return { status: 200, body: "" };
      }),
  };
  const provider = await Effect.runPromise(makeRuntimeProvider({ dockerApi, platform: "linux" }));
  const servicePlan = service(
    { kind: "ref", ref: "debian:12.11-slim" },
    {
      "@lando/core/service-features": {
        buildSteps: [
          { id: "redirect-mkdir", phase: "build", command: ["mkdir", "-p", "/logs"] },
          { id: "redirect", phase: "build", command: ["ln", "-sf", "/dev/stdout", "/logs/access.log"] },
        ],
      },
    },
  );

  await Effect.runPromise(
    Effect.scoped(
      provider.buildArtifact({
        app: appId,
        service: serviceName,
        plan: plan(servicePlan),
        buildKey: "redirect-key",
      }),
    ),
  );

  expect(requestBody).toContain("FROM debian:12.11-slim");
  expect(requestBody).toContain(
    'RUN ["mkdir","-p","/logs"]\nRUN ["ln","-sf","/dev/stdout","/logs/access.log"]',
  );
});
