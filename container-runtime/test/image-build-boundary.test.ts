import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import { buildContainerArtifact } from "@lando/container-runtime/image-build";
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
const appId = AppId.make("build-boundary-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-21T00:00:00Z"),
  source: "container-runtime/image-build-boundary.test.ts",
  runtime: 4 as const,
};

const service = (input: Partial<ServicePlan>): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
  ...input,
});

const plan = (servicePlan: ServicePlan): AppPlan => ({
  id: appId,
  name: "Build Boundary App",
  slug: "build-boundary-app",
  root: AbsolutePath.make("/tmp/build-boundary-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const derivedService = (artifact: ServicePlan["artifact"]): ServicePlan =>
  service({
    artifact,
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [{ id: "step", phase: "build", command: ["echo", "ok"] }],
      },
    },
  });

test.each([
  ['{"error":"executor failed"}\n', "executor failed"],
  ['{"errorDetail":{"message":"container command failed"}}\n', "container command failed"],
])("fails a 2xx build when its JSON stream reports an error", async (body, message) => {
  const api = {
    request: (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
      Effect.succeed(request.method === "POST" ? { status: 200, body } : { status: 200, body: "{}" }),
  };

  const failure = await Effect.runPromise(
    Effect.flip(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(derivedService({ kind: "ref", ref: "alpine:3.22" })),
          buildKey: "stream-error",
        },
        { providerId, api },
      ),
    ),
  );

  expect(failure._tag).toBe("ProviderUnavailableError");
  expect(failure.operation).toBe("buildArtifact");
  expect(JSON.stringify(failure)).toContain(message);
});

test("finds a valid error frame among malformed and partial JSON lines", async () => {
  const api = {
    request: (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
      Effect.succeed({
        status: 200,
        body:
          request.method === "POST"
            ? 'not-json\n{"stream":"working"}\n{"error":"valid failure"}\n{"partial"'
            : "{}",
      }),
  };

  const failure = await Effect.runPromise(
    Effect.flip(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(derivedService({ kind: "ref", ref: "alpine:3.22" })),
          buildKey: "malformed-stream",
        },
        { providerId, api },
      ),
    ),
  );

  expect(JSON.stringify(failure)).toContain("valid failure");
});

test("returns an artifact without a digest when exact-tag image inspect succeeds", async () => {
  const requests: Array<{ readonly method: string; readonly path: string }> = [];
  const api = {
    request: (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
      Effect.sync(() => {
        requests.push(request);
        return request.method === "POST"
          ? { status: 200, body: "" }
          : { status: 200, body: '{"Id":"image"}' };
      }),
  };

  const artifact = await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(derivedService({ kind: "ref", ref: "alpine:3.22" })),
        buildKey: "inspect-success",
      },
      { providerId, api },
    ),
  );

  expect(artifact).toEqual({ providerId, ref: "lando-build-docker-web-inspect-success" });
  expect(requests.at(-1)).toEqual({
    method: "GET",
    path: "/images/lando-build-docker-web-inspect-success/json",
  });
});

test("fails buildArtifact when exact-tag image inspect returns 404", async () => {
  const api = {
    request: (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
      Effect.succeed(
        request.method === "POST"
          ? { status: 200, body: "" }
          : { status: 404, body: '{"message":"No such image"}' },
      ),
  };

  const failure = await Effect.runPromise(
    Effect.flip(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(derivedService({ kind: "ref", ref: "alpine:3.22" })),
          buildKey: "inspect-missing",
        },
        { providerId, api },
      ),
    ),
  );

  expect(failure._tag).toBe("ProviderUnavailableError");
  expect(failure.operation).toBe("buildArtifact");
  expect(failure.details).toEqual(expect.objectContaining({ status: 404 }));
});

test("verifies base and derived tags when both builds run", async () => {
  const context = await mkdtemp(join(tmpdir(), "lando-build-boundary-"));
  try {
    await writeFile(join(context, "Containerfile"), "FROM alpine\n");
    const inspected: string[] = [];
    const api = {
      request: (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
        Effect.sync(() => {
          if (request.method === "GET") inspected.push(request.path);
          return { status: 200, body: request.method === "GET" ? "{}" : "" };
        }),
    };

    await Effect.runPromise(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(
            derivedService({
              kind: "build",
              context: AbsolutePath.make(context),
              spec: PortablePath.make("Containerfile"),
            }),
          ),
          buildKey: "two-builds",
        },
        { providerId, api },
      ),
    );

    expect(inspected).toEqual([
      "/images/lando-build-docker-web-two-builds-base/json",
      "/images/lando-build-docker-web-two-builds/json",
    ]);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("redacts build arguments from surfaced stream errors", async () => {
  const secret = "top secret/+?";
  const context = await mkdtemp(join(tmpdir(), "lando-build-secret-boundary-"));
  try {
    await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
    const api = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: `{"errorDetail":{"message":"failed with TOKEN=${secret} (${encodeURIComponent(secret)})"}}\n`,
        }),
    };

    const failure = await Effect.runPromise(
      Effect.flip(
        buildContainerArtifact(
          {
            app: appId,
            service: serviceName,
            plan: plan(
              service({
                artifact: {
                  kind: "build",
                  context: AbsolutePath.make(context),
                  args: { TOKEN: secret },
                },
              }),
            ),
            buildKey: "secret-stream",
          },
          { providerId, api },
        ),
      ),
    );

    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).toContain("[redacted]");
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
