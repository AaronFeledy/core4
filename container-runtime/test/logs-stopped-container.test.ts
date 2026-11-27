import { expect, test } from "bun:test";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import { AbsolutePath, AppId, type AppPlan, LogSource, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Schema, Stream } from "effect";
import type { EngineHttpApi, EngineHttpResponse } from "../src/engine-api.ts";
import { scopedDockerLogFileAccess } from "../src/log-file-access.ts";
import { serviceContainerName } from "../src/plan.ts";
import { logs } from "../src/podman/logs.ts";

const app = AppId.make("database-logs");
const service = ServiceName.make("db");
const provider = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const source = Schema.decodeUnknownSync(LogSource)({
  id: "slow-query",
  strategy: "follow",
  path: "/var/lib/mysql/slow-query.log",
  stream: "stderr",
});
const plan: AppPlan = {
  id: app,
  name: app,
  slug: app,
  root: AbsolutePath.make("/tmp/database-logs"),
  provider,
  metadata,
  extensions: {},
  routes: [],
  stores: [],
  fileSync: [],
  services: {
    [service]: {
      name: service,
      type: "mariadb",
      provider,
      primary: true,
      artifact: { kind: "ref", ref: "mariadb:10.6" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
      logSources: [source],
    },
  },
};

const execFailures = {
  podman: {
    status: 500,
    body: JSON.stringify({
      cause: "container state improper",
      message: "can only create exec sessions on running containers: container state improper",
      response: 500,
    }),
  },
  docker: { status: 409, body: JSON.stringify({ message: "Container is not running" }) },
} satisfies Record<string, EngineHttpResponse>;

const inspectState = (status: string): EngineHttpResponse => ({
  status: 200,
  body: JSON.stringify({ State: { Status: status, Running: status === "running" } }),
});

const failingEngine = (providerId: keyof typeof execFailures, inspect: EngineHttpResponse) => {
  const container = serviceContainerName(plan, service);
  const base = `/containers/${encodeURIComponent(container)}`;
  const ctx = { providerId, remediation: "Run lando setup.", env: {} };
  let inspections = 0;
  const api: EngineHttpApi = {
    request: ({ method, path }) => {
      if (method === "POST" && path === `${base}/exec`) return Effect.succeed(execFailures[providerId]);
      if (method === "GET" && path === `${base}/json`) {
        inspections++;
        return Effect.succeed(inspect);
      }
      throw new Error(`Unexpected engine request: ${method} ${path}`);
    },
    stream: ({ method, path }) => {
      if (method !== "GET" || !path.startsWith(`${base}/logs?`))
        throw new Error(`Unexpected engine stream: ${method} ${path}`);
      const payload = Buffer.from("2026-05-14T00:00:00Z database startup failed\n");
      const header = Buffer.alloc(8);
      header[0] = 2;
      header.writeUInt32BE(payload.length, 4);
      return Stream.make(Buffer.concat([header, payload]));
    },
  };
  const logFileAccess = scopedDockerLogFileAccess({
    providerId,
    api,
    container,
    resolveHelper: Effect.succeed({
      target: { os: "linux", arch: "x64" },
      path: AbsolutePath.make(import.meta.filename),
      digest: "1".repeat(64),
    }),
    sourceEnv: {},
  });
  return { api, ctx, logFileAccess, inspections: () => inspections };
};

test.each([
  ["podman", "exited", inspectState("exited")],
  ["docker", "exited", inspectState("exited")],
  ["podman", "created", inspectState("created")],
  ["podman", "dead", inspectState("dead")],
  ["podman", "absent", { status: 404, body: "" }],
] as const)(
  "keeps %s console logs when the file source fails and the container is %s",
  async (id, _, inspect) => {
    const engine = failingEngine(id, inspect);
    const chunks = await Effect.runPromise(
      Stream.runCollect(logs(plan, { app, service }, { follow: false, tail: 50 }, engine)),
    );

    expect(chunks.map(({ line, stream, source }) => ({ line, stream, source }))).toEqual([
      { line: "database startup failed", stream: "stderr", source: undefined },
    ]);
    expect(engine.inspections()).toBe(1);
  },
);

test.each([
  ["running", inspectState("running")],
  ["unavailable", { status: 503, body: "" }],
  ["malformed", { status: 200, body: '{"State":{"Status":42}}' }],
] as const)("preserves the file-source error when inspect reports %s", async (_, inspect) => {
  const engine = failingEngine("podman", inspect);
  const error = await Effect.runPromise(
    Stream.runCollect(logs(plan, { app, service }, { follow: false }, engine)).pipe(Effect.flip),
  );

  expect(error).toMatchObject({
    _tag: "ProviderUnavailableError",
    operation: "logFileAccess",
    details: { status: 500 },
  });
  expect(engine.inspections()).toBe(1);
});

test("reports a stopped service when its file source is explicitly requested", async () => {
  const engine = failingEngine("podman", inspectState("exited"));
  const error = await Effect.runPromise(
    Stream.runCollect(logs(plan, { app, service }, { follow: false, source: source.id }, engine)).pipe(
      Effect.flip,
    ),
  );

  expect(error).toMatchObject({ _tag: "ServiceExecError", service, details: { containerState: "exited" } });
});

test("collects readable file and console logs without inspecting the container", async () => {
  const engine = failingEngine("podman", { status: 503, body: "" });
  const fs = makeMemoryLogFileAccess();
  fs.writeFile("/var/lib/mysql/slow-query.log", "slow query\n");
  const chunks = await Effect.runPromise(
    Stream.runCollect(
      logs(plan, { app, service }, { follow: false }, { ...engine, logFileAccess: fs.access }),
    ),
  );

  expect(chunks.map(({ line }) => line).toSorted()).toEqual(["database startup failed", "slow query"]);
  expect(engine.inspections()).toBe(0);
});
