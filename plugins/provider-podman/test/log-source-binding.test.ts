import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema, Stream } from "effect";

import * as PodmanProvider from "@lando/provider-podman";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import { AbsolutePath, AppId, type AppPlan, LogSource, ProviderId, ServiceName } from "@lando/sdk/schema";

const app = AppId.make("bindingapp");
const service = ServiceName.make("web");
const providerId = ProviderId.make("podman");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const source = Schema.decodeUnknownSync(LogSource)({
  id: "app-log",
  path: "/app.log",
  stream: "stdout",
  strategy: "follow",
});
const plan: AppPlan = {
  id: app,
  name: "Binding App",
  slug: "bindingapp",
  root: AbsolutePath.make("/tmp/bindingapp"),
  provider: providerId,
  services: {
    [service]: {
      name: service,
      type: "node",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "node:22" },
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      logSources: [source],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const api = {
  info: Effect.succeed({ version: { Version: "6.0.2" }, host: { arch: "x64" } }),
  ping: Effect.void,
};

describe("provider-podman log source binding", () => {
  test("reads injected files instead of a different helper fallback", async () => {
    // Given: injected content and a helper fallback with no request transport.
    const memory = makeMemoryLogFileAccess();
    memory.writeFile(source.path, "override\n");
    const provider = await Effect.runPromise(
      PodmanProvider.makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: api,
        logFileAccess: memory.access,
        logFileHelperPayloads: { "linux-x64": new Uint8Array([1]) },
      }),
    );
    // When: only the file source is requested.
    const chunks = await Effect.runPromise(
      Stream.runCollect(provider.logs({ app, service, plan }, { follow: false, source: source.id })),
    );
    // Then: the override provides the lines.
    expect(chunks.map((chunk) => chunk.line)).toEqual(["override"]);
  });

  test("keeps the no-plan error even when file access is injected", async () => {
    // Given: no applied plan and injected file access.
    const provider = await Effect.runPromise(
      PodmanProvider.makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: api,
        logFileAccess: makeMemoryLogFileAccess().access,
      }),
    );
    // When: logs are requested without a plan.
    const result = await Effect.runPromise(
      Effect.result(Stream.runCollect(provider.logs({ app, service }, { follow: false }))),
    );
    // Then: plan resolution still owns the failure.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", providerId: "podman", operation: "logs" },
    });
  });

  test("installs helper access in the service container derived from the plan", async () => {
    // Given: a helper payload and an API that refuses uploads.
    const paths: string[] = [];
    const provider = await Effect.runPromise(
      PodmanProvider.makeRuntimeProvider({
        platform: "linux",
        env: {},
        podmanApi: {
          ...api,
          request: (request) => {
            paths.push(request.path);
            return Effect.succeed({ status: 503, body: "unavailable" });
          },
        },
        logFileHelperPayloads: { "linux-x64": new Uint8Array([1]) },
      }),
    );
    // When: file logs attempt to install the helper.
    await Effect.runPromise(
      Effect.result(
        Stream.runCollect(provider.logs({ app, service, plan }, { follow: false, source: source.id })),
      ),
    );
    // Then: upload targets this service, not another container.
    expect(paths[0]).toBe("/containers/lando-bindingapp-web/archive?path=/tmp");
  });
});
