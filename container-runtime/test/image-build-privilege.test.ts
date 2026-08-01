import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import {
  type ContainerBuildHttpRequest,
  type ContainerBuildHttpResponse,
  buildContainerArtifact,
} from "@lando/container-runtime/image-build";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("privilege-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-01T00:00:00Z"),
  source: "image-build-privilege.test.ts",
  runtime: 4 as const,
};

type BuildStep = {
  readonly id: string;
  readonly phase: "build";
  readonly command: string | ReadonlyArray<string>;
  readonly privileged?: boolean;
};

const privilegedScaffoldStep = {
  id: "lando.boot",
  phase: "build",
  command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
  privileged: true,
} as const satisfies BuildStep;

type RunBuildInput = {
  readonly artifact: NonNullable<ServicePlan["artifact"]>;
  readonly steps: ReadonlyArray<BuildStep>;
  readonly request: (request: ContainerBuildHttpRequest) => Effect.Effect<ContainerBuildHttpResponse>;
  readonly user?: string;
};

const runBuild = (input: RunBuildInput) => {
  const service: ServicePlan = {
    name: serviceName,
    type: "node",
    provider: providerId,
    primary: true,
    artifact: input.artifact,
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: { "@lando/core/service-features": { buildSteps: input.steps } },
    ...(input.user === undefined ? {} : { user: input.user }),
  };
  const plan: AppPlan = {
    id: appId,
    name: "Privilege Build App",
    slug: "privilege-build-app",
    root: AbsolutePath.make("/tmp/privilege-build-app"),
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  return buildContainerArtifact(
    { app: appId, service: serviceName, plan, buildKey: "privilege-key" },
    { providerId, api: { request: input.request } },
  );
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

describe("privileged artifact build steps", () => {
  test("restores the exact inherited non-root user before later steps and ignores the runtime user", async () => {
    // Given
    const posts: ContainerBuildHttpRequest[] = [];
    const request = (entry: ContainerBuildHttpRequest) => {
      if (entry.method === "POST") posts.push(entry);
      return Effect.succeed({
        status: 200,
        body:
          entry.method === "GET" && entry.path.includes("-base") ? '{"Config":{"User":"app:staff"}}' : "{}",
      });
    };

    // When
    await Effect.runPromise(
      runBuild({
        artifact: { kind: "ref", ref: "debian:12" },
        user: "runtime-only",
        steps: [privilegedScaffoldStep, { id: "later", phase: "build", command: "compile-as-app" }],
        request,
      }),
    );

    // Then
    const dockerfile = await dockerfileFrom(
      posts[1] ??
        (() => {
          throw new Error("missing derived build");
        })(),
    );
    expect(dockerfile).toBe(
      "FROM lando-build-docker-web-privilege-key-base\nUSER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER app:staff\nRUN compile-as-app\n",
    );
    expect(dockerfile).not.toContain("runtime-only");
  });

  test("does not emit USER transitions when the inherited user is root", async () => {
    // Given
    const posts: ContainerBuildHttpRequest[] = [];
    const request = (entry: ContainerBuildHttpRequest) => {
      if (entry.method === "POST") posts.push(entry);
      return Effect.succeed({ status: 200, body: '{"Config":{"User":"root:wheel"}}' });
    };

    // When
    await Effect.runPromise(
      runBuild({
        artifact: { kind: "ref", ref: "debian:12" },
        steps: [privilegedScaffoldStep],
        request,
      }),
    );

    // Then
    expect(
      await dockerfileFrom(
        posts[1] ??
          (() => {
            throw new Error("missing derived build");
          })(),
      ),
    ).toBe(
      "FROM lando-build-docker-web-privilege-key-base\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\n",
    );
  });

  test("inspects a build artifact's intermediate parent before the privileged derived build", async () => {
    // Given
    const context = await mkdtemp(join(tmpdir(), "lando-privilege-build-"));
    await writeFile(join(context, "Dockerfile"), "FROM debian:12\n");
    const requests: ContainerBuildHttpRequest[] = [];
    const request = (entry: ContainerBuildHttpRequest) => {
      requests.push(entry);
      const baseInspect = entry.method === "GET" && entry.path.includes("-base");
      return Effect.succeed({ status: 200, body: baseInspect ? '{"Config":{"User":"1001:1002"}}' : "{}" });
    };

    // When
    await Effect.runPromise(
      runBuild({
        artifact: { kind: "build", context: AbsolutePath.make(context) },
        steps: [privilegedScaffoldStep],
        request,
      }),
    );

    // Then
    const baseInspects = requests.filter((entry) => entry.method === "GET" && entry.path.includes("-base"));
    const derivedPost = requests.filter((entry) => entry.method === "POST")[1];
    expect(baseInspects).toHaveLength(2);
    if (derivedPost === undefined) throw new Error("missing derived build");
    expect(await dockerfileFrom(derivedPost)).toContain(
      "USER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER 1001:1002",
    );
  });

  test("does not inspect the parent or alter the Dockerfile for unprivileged steps", async () => {
    // Given
    const requests: ContainerBuildHttpRequest[] = [];
    const request = (entry: ContainerBuildHttpRequest) => {
      requests.push(entry);
      return Effect.succeed({ status: 200, body: "{}" });
    };

    // When
    await Effect.runPromise(
      runBuild({
        artifact: { kind: "ref", ref: "debian:12" },
        steps: [{ id: "ordinary", phase: "build", command: "compile" }],
        request,
      }),
    );

    // Then
    expect(requests.filter((entry) => entry.method === "GET")).toHaveLength(1);
    const post = requests.find((entry) => entry.method === "POST");
    if (post === undefined) throw new Error("missing derived build");
    expect(await dockerfileFrom(post)).toBe("FROM debian:12\nRUN compile\n");
  });

  test("rejects inherited users containing Dockerfile control characters", async () => {
    // Given / When
    const failure = await Effect.runPromise(
      Effect.flip(
        runBuild({
          artifact: { kind: "ref", ref: "debian:12" },
          steps: [{ id: "privileged", phase: "build", command: "install", privileged: true }],
          request: () => Effect.succeed({ status: 200, body: '{"Config":{"User":"app\\nUSER root"}}' }),
        }),
      ),
    );

    // Then
    expect(failure._tag).toBe("ProviderInternalError");
    expect(failure.message).toContain("control characters");
  });

  test("fails closed when inherited-user inspection is non-successful", async () => {
    // Given
    let baseInspectCount = 0;
    const request = (entry: ContainerBuildHttpRequest) => {
      if (entry.method === "POST") return Effect.succeed({ status: 200, body: "" });
      if (entry.path.includes("-base")) {
        baseInspectCount += 1;
        return Effect.succeed(
          baseInspectCount === 1 ? { status: 200, body: "{}" } : { status: 503, body: "unavailable" },
        );
      }
      return Effect.succeed({ status: 200, body: "{}" });
    };

    // When
    const failure = await Effect.runPromise(
      Effect.flip(
        runBuild({
          artifact: { kind: "ref", ref: "debian:12" },
          steps: [{ id: "privileged", phase: "build", command: "install", privileged: true }],
          request,
        }),
      ),
    );

    // Then
    expect(failure._tag).toBe("ProviderUnavailableError");
    expect(failure.remediation).toBeDefined();
  });

  test.each(["not-json", "{}", '{"Config":{"User":42}}'])(
    "fails closed for malformed inherited-user inspection: %s",
    async (body) => {
      // Given / When
      const failure = await Effect.runPromise(
        Effect.flip(
          runBuild({
            artifact: { kind: "ref", ref: "debian:12" },
            steps: [{ id: "privileged", phase: "build", command: "install", privileged: true }],
            request: () => Effect.succeed({ status: 200, body }),
          }),
        ),
      );

      // Then
      expect(failure._tag).toBe("ProviderInternalError");
      expect(failure.remediation).toBeDefined();
    },
  );
});
