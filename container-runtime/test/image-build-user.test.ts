import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  type ContainerBuildHttpRequest,
  type ContainerBuildHttpResponse,
  buildContainerArtifact,
} from "@lando/container-runtime/image-build";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("image-build-user-app");
const serviceName = ServiceName.make("web");
const baseTag = "lando-build-docker-web-privilege-key-base";
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-01T00:00:00Z"),
  source: "image-build-user.test.ts",
  runtime: 4 as const,
};

const buildWithInspection = (
  request: (
    entry: ContainerBuildHttpRequest,
  ) => Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError>,
) => {
  const service: ServicePlan = {
    name: serviceName,
    type: "node",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "debian:12" },
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
          {
            id: "lando.boot",
            phase: "build",
            command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
            privileged: true,
          },
        ],
      },
    },
  };
  const plan: AppPlan = {
    id: appId,
    name: "Image Build User App",
    slug: "image-build-user-app",
    root: AbsolutePath.make("/tmp/image-build-user-app"),
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
    { providerId, api: { request } },
  );
};

const inspectionEffect = (user: string | undefined) =>
  buildWithInspection((entry) =>
    Effect.succeed({
      status: 200,
      body:
        entry.method === "POST" ? "" : JSON.stringify({ Config: user === undefined ? {} : { User: user } }),
    }),
  );

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

const dockerfileFor = async (user: string | undefined): Promise<string> => {
  const posts: ContainerBuildHttpRequest[] = [];
  await Effect.runPromise(
    buildWithInspection((entry) => {
      if (entry.method === "POST") posts.push(entry);
      return Effect.succeed({
        status: 200,
        body:
          entry.method === "POST" ? "" : JSON.stringify({ Config: user === undefined ? {} : { User: user } }),
      });
    }),
  );
  const derived = posts[1];
  if (derived === undefined) throw new Error("missing derived build");
  return dockerfileFrom(derived);
};

describe("inherited image user inspection through artifact builds", () => {
  test.each(["app", "app:staff", "1001:1002", "_www", "app.user-name:staff.group-name"])(
    "accepts a safe inherited user token through the privileged build path: %s",
    async (user) => {
      // Given / When
      const dockerfile = await dockerfileFor(user);

      // Then
      expect(dockerfile).toBe(
        `FROM ${baseTag}\nUSER root\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\nUSER ${user}\n`,
      );
    },
  );

  test.each([undefined, "", "root", "root:wheel", "0", "0:staff"])(
    "accepts an absent, empty, or exact root identity without an unsafe switch: %s",
    async (user) => {
      // Given / When
      const dockerfile = await dockerfileFor(user);

      // Then
      expect(dockerfile).toBe(`FROM ${baseTag}\nRUN mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs\n`);
    },
  );

  test.each([
    ["ASCII space", "app user"],
    ["NBSP", "app\u00a0user"],
    ["whitespace-only", "   "],
    ["root with trailing space", "root "],
    ["trailing backslash", "app\\"],
    ["embedded backslash", "app\\staff"],
  ])("rejects a user token containing %s", async (_case, user) => {
    // Given / When
    const failure = await Effect.runPromise(Effect.flip(inspectionEffect(user)));

    // Then
    expect(failure._tag).toBe("ProviderInternalError");
    expect(failure.message).toContain("inherited image user");
  });

  test("preserves provider-unavailable inherited-user inspection failures", async () => {
    // Given
    const incoming = new ProviderUnavailableError({
      providerId: "docker",
      operation: "buildArtifact",
      message: "Inherited image inspection transport unavailable.",
      remediation: "Restore the container API transport.",
    });
    let inspectCount = 0;
    const request = (entry: ContainerBuildHttpRequest) => {
      if (entry.method === "POST") return Effect.succeed({ status: 200, body: "" });
      inspectCount += 1;
      return inspectCount === 1 ? Effect.succeed({ status: 200, body: "{}" }) : Effect.fail(incoming);
    };

    // When
    const failure = await Effect.runPromise(Effect.flip(buildWithInspection(request)));

    // Then
    expect(failure).toBe(incoming);
    expect(failure._tag).toBe("ProviderUnavailableError");
    expect(failure.message).toBe(incoming.message);
  });
});
