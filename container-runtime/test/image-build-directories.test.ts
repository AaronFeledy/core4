import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { type ContainerBuildHttpRequest, buildContainerArtifact } from "@lando/container-runtime/image-build";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
  source: "image-build-directories.test.ts",
  runtime: 4 as const,
};

const planFor = (directories: readonly string[]): AppPlan => ({
  id: AppId.make("shellless"),
  name: "shellless",
  slug: "shellless",
  root: AbsolutePath.make("/tmp/shellless"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "lando",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "scratch" },
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
          buildSteps: [{ phase: "build", command: { directories } }],
        },
      },
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

test("creates scaffold directories with COPY when the image has no executables", async () => {
  // Given
  const plan = planFor(["/etc/lando", "/etc/lando/env.d", "/etc/lando/certs"]);
  const archives: Buffer[] = [];
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        const chunks: Uint8Array[] = [];
        if (request.stdin !== undefined) {
          for await (const chunk of request.stdin) chunks.push(chunk);
          archives.push(Buffer.concat(chunks));
        }
        return { status: 200, body: "" };
      }),
  };
  // When
  await Effect.runPromise(
    buildContainerArtifact(
      { app: plan.id, service: serviceName, plan, buildKey: "directories" },
      { providerId, api },
    ),
  );
  // Then
  expect(archives).toHaveLength(1);
  const archive = archives[0];
  expect(archive).toBeDefined();
  if (archive === undefined) return;
  const text = archive.toString();
  expect(text).toContain('COPY [".lando-empty/","/etc/lando/"]');
  expect(text).toContain('COPY [".lando-empty/","/etc/lando/env.d/"]');
  expect(text).toContain('COPY [".lando-empty/","/etc/lando/certs/"]');
  expect(text).not.toContain("RUN ");
  expect(text).not.toContain("USER ");
  const directoryHeader = archive.indexOf(".lando-empty/", 1024);
  expect(directoryHeader).toBeGreaterThan(0);
  expect(archive[directoryHeader + 156]).toBe("5".charCodeAt(0));
});

test.each(["relative", "/", "/etc/../tmp", "/etc/lando\nRUN evil"])(
  "rejects unsafe directory %j before any provider request",
  async (directory) => {
    // Given
    const plan = planFor([directory]);
    let requests = 0;
    // When
    const result = await Effect.runPromise(
      Effect.either(
        buildContainerArtifact(
          { app: plan.id, service: serviceName, plan, buildKey: "unsafe" },
          {
            providerId,
            api: {
              request: () => {
                requests++;
                return Effect.succeed({ status: 200, body: "" });
              },
            },
          },
        ),
      ),
    );
    // Then
    expect(result._tag).toBe("Left");
    expect(requests).toBe(0);
  },
);
