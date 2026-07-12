import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { AbsolutePath, PortablePath, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { buildKeyForService } from "../../src/services/build-key.ts";

const providerId = ProviderId.make("test");

const provider = (input: Partial<Pick<RuntimeProviderShape, "id" | "version" | "platform">> = {}) => ({
  ...TestRuntimeProvider,
  id: input.id ?? providerId,
  version: input.version ?? "1.0.0",
  platform: input.platform ?? "linux",
});

const service = (input: Partial<ServicePlan> = {}): ServicePlan => ({
  name: ServiceName.make("web"),
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
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00.000Z"),
    source: "build-key.test",
    runtime: 4,
  },
  extensions: {},
  ...input,
});

const key = (plan: ServicePlan, runtime: RuntimeProviderShape = provider()) =>
  Effect.runPromise(buildKeyForService(runtime, plan));

describe("buildKeyForService", () => {
  test("invalidates on recipe and service artifact inputs", async () => {
    const context = await mkdtemp(join(tmpdir(), "lando-build-key-input-a-"));
    const otherContext = await mkdtemp(join(tmpdir(), "lando-build-key-input-b-"));
    await writeFile(join(context, "Containerfile"), "FROM alpine\n");
    await writeFile(join(otherContext, "Containerfile"), "FROM busybox\n");
    const baseArtifact = {
      kind: "build" as const,
      context: AbsolutePath.make(context),
      spec: PortablePath.make("Containerfile"),
    };
    const base = service({
      artifact: baseArtifact,
    });

    expect(
      await key({ ...base, artifact: { ...baseArtifact, spec: PortablePath.make("Recipefile") } }),
    ).not.toBe(await key(base));
    expect(
      await key({
        ...base,
        artifact: { ...baseArtifact, context: AbsolutePath.make(otherContext) },
      }),
    ).not.toBe(await key(base));
    expect(await key({ ...base, command: ["php", "-v"] })).not.toBe(await key(base));
    expect(await key({ ...base, entrypoint: ["/lando-entrypoint"] })).not.toBe(await key(base));
  });

  test("invalidates on redirect log-source build-step inputs", async () => {
    const withRedirect = service({
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [
            {
              id: "lando-log-redirect:access",
              phase: "build",
              command: ["ln", "-sf", "/dev/stdout", "/var/log/nginx/access.log"],
            },
          ],
        },
      },
    });
    const changedRedirect = service({
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [
            {
              id: "lando-log-redirect:access",
              phase: "build",
              command: ["ln", "-sf", "/dev/stderr", "/var/log/nginx/access.log"],
            },
          ],
        },
      },
    });

    expect(await key(changedRedirect)).not.toBe(await key(withRedirect));
  });

  test("invalidates on base image, build args, provider identity, and provider-visible env", async () => {
    const context = await mkdtemp(join(tmpdir(), "lando-build-key-args-"));
    await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
    const base = service({
      artifact: { kind: "ref", ref: "debian:12.11-slim" },
      environment: { NODE_ENV: "production" },
    });

    expect(await key({ ...base, artifact: { kind: "ref", ref: "ubuntu:24.04" } })).not.toBe(await key(base));
    expect(
      await key({
        ...base,
        artifact: {
          kind: "build",
          context: AbsolutePath.make(context),
          args: { FLAVOR: "bookworm" },
        },
      }),
    ).not.toBe(
      await key({
        ...base,
        artifact: {
          kind: "build",
          context: AbsolutePath.make(context),
          args: { FLAVOR: "trixie" },
        },
      }),
    );
    expect(await key(base, provider({ id: "other" }))).not.toBe(await key(base));
    expect(await key(base, provider({ version: "2.0.0" }))).not.toBe(await key(base));
    expect(await key(base, provider({ platform: "darwin" }))).not.toBe(await key(base));
    expect(await key({ ...base, environment: { NODE_ENV: "development" } })).not.toBe(await key(base));
    expect(
      await key({ ...base, environment: { ...base.environment, LANDO_APP_ROOT: "/tmp/scratch-b" } }),
    ).toBe(await key({ ...base, environment: { ...base.environment, LANDO_APP_ROOT: "/tmp/scratch-a" } }));
  });

  test("hashes secret reference names without hashing resolved secret values", async () => {
    const token = service({ environment: { TOKEN: "${secret:NPM_TOKEN}" } });
    const sameToken = service({ environment: { TOKEN: "${secret:NPM_TOKEN}" } });
    const otherToken = service({ environment: { TOKEN: "${secret:OTHER_TOKEN}" } });

    expect(await key(sameToken)).toBe(await key(token));
    expect(await key(otherToken)).not.toBe(await key(token));
  });

  test("hashes the realized build context instead of the host root", async () => {
    const first = await mkdtemp(join(tmpdir(), "lando-build-key-a-"));
    const second = await mkdtemp(join(tmpdir(), "lando-build-key-b-"));
    await writeFile(join(first, "Dockerfile"), "FROM alpine\n");
    await writeFile(join(second, "Dockerfile"), "FROM alpine\n");
    const base = service({
      artifact: { kind: "build", context: AbsolutePath.make(first), spec: PortablePath.make("Dockerfile") },
    });
    const sameContentOtherRoot = service({
      artifact: { kind: "build", context: AbsolutePath.make(second), spec: PortablePath.make("Dockerfile") },
    });

    expect(await key(sameContentOtherRoot)).toBe(await key(base));

    await writeFile(join(first, "Dockerfile"), "FROM busybox\n");

    expect(await key(base)).not.toBe(await key(sameContentOtherRoot));
  });
});
