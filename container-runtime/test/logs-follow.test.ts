import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LogSource,
  type LogSource as LogSourceType,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { LogChunk } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { logs } from "../src/podman/logs.ts";

const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const providerId = ProviderId.make("lando");
const appId = AppId.make("logfollowapp");
const appRoot = AbsolutePath.make("/tmp/lando-log-follow-app");
const textEncoder = new TextEncoder();
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "logs-follow.test",
  runtime: 4 as const,
};

const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "console.log('ready')"],
  environment: {},
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const source = (
  overrides: Partial<{
    readonly id: string;
    readonly path: string;
    readonly strategy: "follow" | "redirect";
    readonly stream: "stdout" | "stderr";
  }> = {},
): LogSourceType =>
  Schema.decodeUnknownSync(LogSource)({
    id: overrides.id ?? "app-log",
    path: overrides.path ?? "/var/log/app.log",
    stream: overrides.stream ?? "stderr",
    strategy: overrides.strategy ?? "follow",
  });

const makePlan = (logSources?: ReadonlyArray<LogSourceType>): AppPlan => {
  const service: ServicePlan = {
    ...node,
    ...(logSources === undefined ? {} : { logSources }),
  };
  return {
    id: appId,
    name: "Log Follow App",
    slug: "logfollowapp",
    root: appRoot,
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makeFakeApi = (...chunks: ReadonlyArray<Uint8Array>) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    stream: (request) => {
      calls.push(request);
      return Stream.fromIterable(chunks);
    },
  };

  return { api, calls };
};

const rawConsole = (line: string): Uint8Array => textEncoder.encode(`2026-05-14T00:00:00Z ${line}\n`);

const collect = (stream: Stream.Stream<LogChunk, unknown>): Promise<ReadonlyArray<LogChunk>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map((chunks) => [...chunks])));

describe("podman log followers", () => {
  test("merges finite console and file-follow logs when follow is false", async () => {
    const fileSource = source();
    const plan = makePlan([fileSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(fileSource.path, "file ready\n");
    const fake = makeFakeApi(rawConsole("console ready"));

    const chunks = await collect(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, sources: [fileSource] },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    const consoleChunk = chunks.find((chunk) => chunk.line === "console ready");
    const fileChunk = chunks.find((chunk) => chunk.line === "file ready");
    expect(consoleChunk?.source).toBeUndefined();
    expect(fileChunk?.source).toBe(fileSource.id);
    expect(fileChunk?.stream).toBe("stderr");
  });

  test("uses caller-provided log sources before plan-cached service sources", async () => {
    const staleSource = source({ id: "stale", path: "/var/log/stale.log" });
    const freshSource = source({ id: "fresh", path: "/var/log/fresh.log" });
    const plan = makePlan([staleSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(staleSource.path, "stale line\n");
    fs.writeFile(freshSource.path, "fresh line\n");
    const fake = makeFakeApi(rawConsole("console ready"));

    const chunks = await collect(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, sources: [freshSource] },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    expect(chunks.some((chunk) => chunk.line === "fresh line" && chunk.source === freshSource.id)).toBe(true);
    expect(chunks.some((chunk) => chunk.line === "stale line")).toBe(false);
  });

  test("streams only console logs when a service has no follow sources", async () => {
    const redirectSource = source({
      id: "redirected",
      path: "/var/log/redirected.log",
      strategy: "redirect",
    });
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(redirectSource.path, "redirected file\n");
    const fake = makeFakeApi(rawConsole("console only"));

    const chunks = await collect(
      logs(
        makePlan([redirectSource]),
        { app: appId, service: node.name },
        { follow: false, sources: [redirectSource] },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    expect(chunks.map((chunk) => chunk.line)).toEqual(["console only"]);
    expect(chunks[0]?.source).toBeUndefined();
  });

  test("restricts to a single declared source and suppresses console when options.source is set", async () => {
    const fileSource = source();
    const plan = makePlan([fileSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(fileSource.path, "file ready\n");
    const fake = makeFakeApi(rawConsole("console noise"));

    const chunks = await collect(
      logs(
        plan,
        { app: appId, service: node.name },
        { follow: false, sources: [fileSource], source: fileSource.id },
        { api: fake.api, logFileAccess: fs.access, ctx },
      ),
    );

    expect(chunks.map((chunk) => chunk.line)).toEqual(["file ready"]);
    expect(chunks.every((chunk) => chunk.source === fileSource.id)).toBe(true);
    expect(chunks.some((chunk) => chunk.line === "console noise")).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  test("tags a missing-api failure with the caller provider id and remediation", async () => {
    // Given a caller context for the podman provider and no engine API client
    // When
    const error = await Effect.runPromise(
      Stream.runCollect(logs(makePlan(), { app: appId, service: node.name }, {}, { ctx })).pipe(Effect.flip),
    );

    // Then
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.providerId).toBe("podman");
    expect(error.message).toContain("provider-podman");
    expect(error.remediation).toBe(ctx.remediation);
  });
});
