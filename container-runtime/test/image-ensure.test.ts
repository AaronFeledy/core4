import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";

import { dockerPullDialect, libpodPullDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { ensureImage, makeEnsureImage, serviceImagePlatform } from "../src/image-ensure.ts";

const dockerCtx = {
  providerId: "docker",
  remediation: "Run `lando doctor --provider=docker` and retry.",
} as const;
const podmanCtx = {
  providerId: "podman",
  remediation: "Run `lando doctor --provider=podman` and retry.",
} as const;

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-10-01T00:00:00Z"),
  source: "container-runtime/image-ensure.test.ts",
  runtime: 4 as const,
};

const service = (compose?: Record<string, unknown>): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "test",
  provider: ProviderId.make("docker"),
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: compose === undefined ? {} : { compose },
});

const inspectBody = (input: {
  readonly os?: string;
  readonly architecture?: string;
  readonly variant?: string;
  readonly repoDigests?: ReadonlyArray<string>;
}): string =>
  JSON.stringify({
    ...(input.os === undefined ? {} : { Os: input.os }),
    ...(input.architecture === undefined ? {} : { Architecture: input.architecture }),
    ...(input.variant === undefined ? {} : { Variant: input.variant }),
    RepoDigests: input.repoDigests ?? [],
  });

const makeApi = (options: {
  readonly inspectStatus?: number;
  readonly inspectBody?: string;
  readonly pullStatus?: number;
}) => {
  const requests: EngineHttpRequest[] = [];
  let pulled = false;
  const api: EngineHttpApi = {
    request: (request) => {
      requests.push(request);
      if (request.method === "GET" && request.path.endsWith("/json")) {
        return Effect.succeed({
          status: pulled ? 200 : (options.inspectStatus ?? 200),
          body: options.inspectBody ?? inspectBody({ os: "linux", architecture: "amd64" }),
        } satisfies EngineHttpResponse);
      }
      if (request.method === "POST") {
        pulled = true;
        return Effect.succeed({
          status: options.pullStatus ?? 200,
          body: '{"status":"Pull complete"}\n',
        });
      }
      return Effect.succeed({ status: 500, body: `unexpected ${request.method} ${request.path}` });
    },
  };
  return { api, requests };
};

describe("serviceImagePlatform", () => {
  test("reads an explicit compose platform and ignores build.platforms", () => {
    expect(serviceImagePlatform(service({ platform: "linux/amd64" }))).toBe("linux/amd64");
    expect(serviceImagePlatform(service())).toBeUndefined();
    expect(
      serviceImagePlatform(
        service({
          build: { platforms: ["linux/amd64"] },
          platforms: ["linux/arm64"],
        }),
      ),
    ).toBeUndefined();
  });
});

describe("ensureImage", () => {
  test("forwards an explicit platform on Docker and libpod pulls when the image is missing", async () => {
    const docker = makeApi({ inspectStatus: 404 });
    const libpod = makeApi({ inspectStatus: 404 });

    await Effect.runPromise(
      ensureImage(docker.api, "nginx:1.27", {
        ctx: dockerCtx,
        dialect: dockerPullDialect,
        platform: "linux/amd64",
      }),
    );
    await Effect.runPromise(
      ensureImage(libpod.api, "nginx:1.27", {
        ctx: podmanCtx,
        dialect: libpodPullDialect,
        platform: "linux/amd64",
      }),
    );

    expect(docker.requests[1]?.path).toContain("platform=linux%2Famd64");
    expect(libpod.requests[1]?.path).toContain("OS=linux");
    expect(libpod.requests[1]?.path).toContain("Arch=amd64");
    expect(libpod.requests[1]?.path).not.toContain("platform=");
  });

  test("keeps the current pull call when no platform is pinned", async () => {
    const docker = makeApi({ inspectStatus: 404 });
    const libpod = makeApi({ inspectStatus: 404 });

    await Effect.runPromise(
      ensureImage(docker.api, "nginx:1.27", { ctx: dockerCtx, dialect: dockerPullDialect }),
    );
    await Effect.runPromise(
      ensureImage(libpod.api, "nginx:1.27", { ctx: podmanCtx, dialect: libpodPullDialect }),
    );

    expect(docker.requests[1]?.path).toBe("/images/create?fromImage=nginx&tag=1.27");
    expect(libpod.requests[1]?.path).toBe(
      "/libpod/images/pull?reference=nginx%3A1.27&pullProgress=true",
    );
  });

  test("treats a present matching image as already available", async () => {
    const fake = makeApi({
      inspectBody: inspectBody({
        os: "linux",
        architecture: "amd64",
        repoDigests: ["nginx@sha256:test"],
      }),
    });

    await Effect.runPromise(
      ensureImage(fake.api, "nginx:1.27", {
        ctx: dockerCtx,
        dialect: dockerPullDialect,
        platform: "linux/amd64",
      }),
    );

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("GET");
  });

  test("pulls a wrong-arch registry image with the pin", async () => {
    const fake = makeApi({
      inspectBody: inspectBody({
        os: "linux",
        architecture: "arm64",
        repoDigests: ["nginx@sha256:test"],
      }),
    });

    await Effect.runPromise(
      ensureImage(fake.api, "nginx:1.27", {
        ctx: dockerCtx,
        dialect: dockerPullDialect,
        platform: "linux/amd64",
      }),
    );

    expect(fake.requests.some((request) => request.path.includes("platform=linux%2Famd64"))).toBe(true);
  });

  test("fails a wrong-arch local build and does not pull", async () => {
    const fake = makeApi({
      inspectBody: inspectBody({ os: "linux", architecture: "arm64", repoDigests: [] }),
    });

    const failure = await Effect.runPromise(
      ensureImage(fake.api, "nginx:1.27", {
        ctx: dockerCtx,
        dialect: dockerPullDialect,
        platform: "linux/amd64",
      }).pipe(Effect.flip),
    );

    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.message).toContain("linux/arm64");
    expect(failure.message).toContain("linux/amd64");
    expect(failure.remediation).toContain("Rebuild the image");
    expect(fake.requests.every((request) => request.method !== "POST")).toBe(true);
  });

  test("force:true pulls with the platform pin", async () => {
    const fake = makeApi({
      inspectBody: inspectBody({
        os: "linux",
        architecture: "amd64",
        repoDigests: ["nginx@sha256:test"],
      }),
    });

    await Effect.runPromise(
      ensureImage(fake.api, "nginx:1.27", {
        ctx: dockerCtx,
        dialect: dockerPullDialect,
        force: true,
        platform: "linux/amd64",
      }),
    );

    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.path).toContain("platform=linux%2Famd64");
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("makeEnsureImage reads compose.platform and ignores build.platforms", async () => {
    const pinned = makeApi({ inspectStatus: 404 });
    const buildOnly = makeApi({ inspectStatus: 404 });

    await Effect.runPromise(
      makeEnsureImage(pinned.api, { ctx: dockerCtx, dialect: dockerPullDialect })({
        service: service({ platform: "linux/arm64" }),
        ref: "nginx:1.27",
        force: false,
      }),
    );
    await Effect.runPromise(
      makeEnsureImage(buildOnly.api, { ctx: dockerCtx, dialect: dockerPullDialect })({
        service: service({ build: { platforms: ["linux/amd64"] } }),
        ref: "nginx:1.27",
        force: false,
      }),
    );

    expect(pinned.requests[1]?.path).toContain("platform=linux%2Farm64");
    expect(buildOnly.requests[1]?.path).toBe("/images/create?fromImage=nginx&tag=1.27");
  });
});
