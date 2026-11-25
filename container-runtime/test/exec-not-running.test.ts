import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Stream } from "effect";

import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { exec } from "../src/podman/exec-transport.ts";

const ctx = { providerId: "lando", remediation: "Run `lando setup` and retry.", env: {} } as const;
const providerId = ProviderId.make("lando");
const service = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-24T00:00:00Z"),
  source: "container-runtime/exec-not-running.test.ts",
  runtime: 4 as const,
};

const plan = {
  id: AppId.make("exec-stopped-app"),
  name: "exec-stopped-app",
  slug: "exec-stopped-app",
  root: AbsolutePath.make("/tmp/exec-stopped-app"),
  provider: providerId,
  services: {
    [service]: {
      name: service,
      type: "node",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "node:22-alpine" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
} as const satisfies AppPlan;

const refusingExecCreate = (status: number): EngineHttpApi => ({
  request: (input: EngineHttpRequest) =>
    Effect.succeed(
      input.method === "POST" && input.path.endsWith("/exec")
        ? { status, body: '{"message":"refused"}' }
        : { status: 200, body: JSON.stringify({ Id: "cid-web", State: { Running: false } }) },
    ),
  stream: () => Stream.die("exec start must not run"),
});

test.each([
  // Docker and Podman refuse exec create on a stopped container with 409 and a missing one with 404.
  { state: "stopped", status: 409, message: "Service web is not running." },
  { state: "missing", status: 404, message: "Service web has no container." },
])("exec in a $state container fails with a start-the-app error", async ({ status, message }) => {
  // Given
  const api = refusingExecCreate(status);

  // When
  const error = await Effect.runPromise(
    exec(plan, { app: plan.id, service }, { command: ["php", "-v"] }, { api, ctx }).pipe(Effect.flip),
  );

  // Then the caller is told to start the app
  expect(error).toMatchObject({
    _tag: "ServiceExecError",
    service: "web",
    message,
    remediation: "Run `lando start`, then retry.",
  });
});
