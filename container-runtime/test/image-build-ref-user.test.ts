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
const appId = AppId.make("ref-privilege-build-app");
const serviceName = ServiceName.make("web");
const tag = "lando-build-docker-web-privilege-key";
const baseTag = `${tag}-base`;
const runtimeUser = "runtime-only";
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-01T00:00:00Z"),
  source: "image-build-ref-user.test.ts",
  runtime: 4 as const,
};

const plan = (withRootStep: boolean): AppPlan => {
  const service: ServicePlan = {
    name: serviceName,
    type: "node",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "debian:12", digest: "sha256:resolved-parent" },
    user: runtimeUser,
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
        buildSteps: withRootStep
          ? [
              {
                id: "lando.boot",
                phase: "build",
                command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
                user: "root",
              },
              { id: "later", phase: "build", command: "compile-as-app" },
            ]
          : [{ id: "later", phase: "build", command: "compile-as-app" }],
      },
    },
  };
  return {
    id: appId,
    name: "Ref Privilege Build App",
    slug: "ref-privilege-build-app",
    root: AbsolutePath.make("/tmp/ref-privilege-build-app"),
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const collect = async (stdin: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  if (stdin !== undefined) for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const dockerfileFrom = async (request: ContainerBuildHttpRequest): Promise<string> => {
  const archive = await collect(request.stdin);
  const sizeText = new TextDecoder().decode(archive.subarray(124, 136)).replace(/\0.*$/u, "").trim();
  const size = Number.parseInt(sizeText || "0", 8);
  return new TextDecoder().decode(archive.subarray(512, 512 + size));
};

const run = async (withRootStep: boolean, inheritedUser = "app:staff") => {
  const requests: ContainerBuildHttpRequest[] = [];
  const request = (entry: ContainerBuildHttpRequest) => {
    requests.push(entry);
    if (entry.method === "POST") return Effect.succeed({ status: 200, body: "" });
    if (entry.path === `/images/${baseTag}/json`) {
      return Effect.succeed({ status: 200, body: JSON.stringify({ Config: { User: inheritedUser } }) });
    }
    if (entry.path.includes("debian")) {
      return Effect.succeed({ status: 404, body: '{"message":"No such image"}' });
    }
    return Effect.succeed({ status: 200, body: "{}" });
  };
  await Effect.runPromise(
    buildContainerArtifact(
      { app: appId, service: serviceName, plan: plan(withRootStep), buildKey: "privilege-key" },
      { providerId, api: { request } },
    ),
  );
  const posts = requests.filter((entry) => entry.method === "POST");
  return {
    paths: requests.map((entry) => `${entry.method} ${entry.path}`),
    dockerfiles: await Promise.all(posts.map(dockerfileFrom)),
  };
};

test("materializes a digest-pinned base before inherited-user inspection", async () => {
  // Given / When
  const first = await run(true);
  const repeated = await run(true);

  // Then
  expect(first.paths).toEqual([
    `POST /build?t=${baseTag}&dockerfile=Dockerfile`,
    `GET /images/${baseTag}/json`,
    `GET /images/${baseTag}/json`,
    `POST /build?t=${tag}&dockerfile=Dockerfile`,
    `GET /images/${tag}/json`,
  ]);
  expect(first.dockerfiles).toEqual([
    "FROM debian:12@sha256:resolved-parent\n",
    `FROM ${baseTag}\nUSER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER runtime-only\nRUN compile-as-app\n`,
  ]);
  expect(first.dockerfiles[1]?.match(/^USER .+$/gmu)?.at(-1)).toBe(`USER ${runtimeUser}`);
  expect(repeated).toEqual(first);
});

test("distinguishes root with a group and restores the final service user", async () => {
  // Given / When
  const result = await run(true, "root:wheel");

  // Then
  expect(result.dockerfiles).toEqual([
    "FROM debian:12@sha256:resolved-parent\n",
    `FROM ${baseTag}\nUSER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER runtime-only\nRUN compile-as-app\n`,
  ]);
  expect(result.dockerfiles[0]).not.toContain("USER");
  expect(result.dockerfiles[1]?.match(/^USER .+$/gmu)).toEqual(["USER root", `USER ${runtimeUser}`]);
});

test("inspects a referenced parent for an authored service user even without step users", async () => {
  // Given / When
  const result = await run(false);

  // Then
  expect(result.paths).toEqual([
    `POST /build?t=${baseTag}&dockerfile=Dockerfile`,
    `GET /images/${baseTag}/json`,
    `GET /images/${baseTag}/json`,
    `POST /build?t=${tag}&dockerfile=Dockerfile`,
    `GET /images/${tag}/json`,
  ]);
  expect(result.dockerfiles).toEqual([
    "FROM debian:12@sha256:resolved-parent\n",
    `FROM ${baseTag}\nUSER runtime-only\nRUN compile-as-app\n`,
  ]);
  expect(result.dockerfiles[1]?.match(/^USER .+$/gmu)?.at(-1)).toBe(`USER ${runtimeUser}`);
});
