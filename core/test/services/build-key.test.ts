import { describe, expect, test } from "bun:test";

import { DateTime } from "effect";

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
  buildKeyForService(runtime, plan);

describe("buildKeyForService", () => {
  test("invalidates on recipe and service artifact inputs", () => {
    const baseArtifact = {
      kind: "build" as const,
      context: AbsolutePath.make("/host/scratch/toolbox-a"),
      spec: PortablePath.make("Containerfile"),
      contentHash: "sha256:recipe-a",
    };
    const base = service({
      artifact: baseArtifact,
    });

    expect(key({ ...base, artifact: { ...baseArtifact, contentHash: "sha256:recipe-b" } })).not.toBe(
      key(base),
    );
    expect(key({ ...base, artifact: { ...baseArtifact, spec: PortablePath.make("Recipefile") } })).not.toBe(
      key(base),
    );
    const unhashedContext = { ...baseArtifact, contentHash: undefined };
    expect(
      key({
        ...base,
        artifact: { ...unhashedContext, context: AbsolutePath.make("/host/scratch/toolbox-b") },
      }),
    ).not.toBe(key({ ...base, artifact: unhashedContext }));
    expect(key({ ...base, command: ["php", "-v"] })).not.toBe(key(base));
    expect(key({ ...base, entrypoint: ["/lando-entrypoint"] })).not.toBe(key(base));
  });

  test("invalidates on redirect log-source build-step inputs", () => {
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

    expect(key(changedRedirect)).not.toBe(key(withRedirect));
  });

  test("invalidates on base image, build args, provider identity, and provider-visible env", () => {
    const base = service({
      artifact: { kind: "ref", ref: "debian:12.11-slim" },
      environment: { NODE_ENV: "production" },
    });

    expect(key({ ...base, artifact: { kind: "ref", ref: "ubuntu:24.04" } })).not.toBe(key(base));
    expect(
      key({
        ...base,
        artifact: {
          kind: "build",
          context: AbsolutePath.make("/host/context"),
          args: { FLAVOR: "bookworm" },
          contentHash: "sha256:context",
        },
      }),
    ).not.toBe(
      key({
        ...base,
        artifact: {
          kind: "build",
          context: AbsolutePath.make("/host/context"),
          args: { FLAVOR: "trixie" },
          contentHash: "sha256:context",
        },
      }),
    );
    expect(key(base, provider({ id: "other" }))).not.toBe(key(base));
    expect(key(base, provider({ version: "2.0.0" }))).not.toBe(key(base));
    expect(key(base, provider({ platform: "darwin" }))).not.toBe(key(base));
    expect(key({ ...base, environment: { NODE_ENV: "development" } })).not.toBe(key(base));
    expect(key({ ...base, environment: { ...base.environment, LANDO_APP_ROOT: "/tmp/scratch-b" } })).toBe(
      key({ ...base, environment: { ...base.environment, LANDO_APP_ROOT: "/tmp/scratch-a" } }),
    );
  });

  test("hashes secret reference names without hashing resolved secret values", () => {
    const token = service({ environment: { TOKEN: "${secret:NPM_TOKEN}" } });
    const sameToken = service({ environment: { TOKEN: "${secret:NPM_TOKEN}" } });
    const otherToken = service({ environment: { TOKEN: "${secret:OTHER_TOKEN}" } });

    expect(key(sameToken)).toBe(key(token));
    expect(key(otherToken)).not.toBe(key(token));
  });
});
