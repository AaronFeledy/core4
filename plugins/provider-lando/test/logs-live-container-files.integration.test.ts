import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { makePodmanApiClient, makeRuntimeProvider } from "@lando/provider-lando";
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
import type { LogChunk, RuntimeProviderShape } from "@lando/sdk/services";

import { loadLogFileHelperPayloads } from "../../../core/src/providers/log-file-helper-payloads.ts";
import type { PodmanHttpResponse } from "../src/capabilities.ts";

const liveSocket = resolveLiveProviderSocket();
const providerId = ProviderId.make("lando");
const appId = AppId.make("livefilelogsapp");
const serviceName = ServiceName.make("node");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "logs-live-container-files.integration.test",
  runtime: 4 as const,
};

const source = (input: {
  readonly id: string;
  readonly path: string;
  readonly stream: "stdout" | "stderr";
  readonly timestamps?: boolean;
}): LogSourceType =>
  Schema.decodeUnknownSync(LogSource)({
    id: input.id,
    path: input.path,
    stream: input.stream,
    strategy: "follow",
    required: false,
    ...(input.timestamps === undefined ? {} : { timestamps: input.timestamps }),
  });

const sources = {
  main: source({ id: "main", path: "/tmp/lando-live/main.log", stream: "stderr" }),
  missing: source({ id: "missing", path: "/tmp/lando-live/missing.log", stream: "stdout" }),
  tail: source({ id: "tail", path: "/tmp/lando-live/tail.log", stream: "stdout" }),
  since: source({ id: "since", path: "/tmp/lando-live/since.log", stream: "stdout", timestamps: true }),
  copytruncate: source({ id: "copytruncate", path: "/tmp/lando-live/copytruncate.log", stream: "stderr" }),
  rotate: source({ id: "rotate", path: "/tmp/lando-live/rotate.log", stream: "stdout" }),
  utf8: source({ id: "utf8", path: "/tmp/lando-live/utf8.log", stream: "stdout" }),
  partial: source({ id: "partial", path: "/tmp/lando-live/partial.log", stream: "stderr" }),
  binary: source({ id: "binary", path: "/tmp/lando-live/binary.log", stream: "stderr" }),
} as const;

const service = (appRoot: string): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: [
    "node",
    "-e",
    "require('node:fs').mkdirSync('/tmp/lando-live', { recursive: true }); console.log('live-console-ready'); setInterval(() => {}, 1000)",
  ],
  environment: {},
  appMount: {
    source: AbsolutePath.make(appRoot),
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
  logSources: Object.values(sources),
  metadata,
  extensions: {},
});

const makePlan = (appRoot: string): AppPlan => {
  const node = service(appRoot);
  return {
    id: appId,
    name: "Live File Logs App",
    slug: "livefilelogsapp",
    root: AbsolutePath.make(appRoot),
    provider: providerId,
    services: { [node.name]: node },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const collect = (stream: Stream.Stream<LogChunk, unknown>): Promise<ReadonlyArray<LogChunk>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map((chunks) => [...chunks])));

const collectStage = (
  label: string,
  stream: Stream.Stream<LogChunk, unknown>,
): Promise<ReadonlyArray<LogChunk>> => withTimeout(label, collect(stream));

const withTimeout = async <T>(label: string, promise: Promise<T>, millis = 15_000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${millis}ms`)), millis);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const execOk = async (provider: RuntimeProviderShape, plan: AppPlan, script: string): Promise<string> => {
  const result = await Effect.runPromise(
    provider.exec(
      { app: plan.id, service: serviceName, plan },
      { command: ["node", "-e", script], stdin: "ignore" },
    ),
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
};

const execShellOk = async (
  provider: RuntimeProviderShape,
  plan: AppPlan,
  command: string,
): Promise<string> => {
  const result = await Effect.runPromise(
    provider.exec(
      { app: plan.id, service: serviceName, plan },
      { command: ["sh", "-lc", command], stdin: "ignore" },
    ),
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout;
};

const fileLogs = (
  provider: RuntimeProviderShape,
  plan: AppPlan,
  selected: LogSourceType,
  options: { readonly follow?: boolean; readonly tail?: number; readonly since?: string } = {},
): Stream.Stream<LogChunk, unknown> =>
  provider.logs(
    { app: plan.id, service: serviceName, plan },
    { follow: options.follow ?? false, sources: [selected], source: selected.id, ...options },
  );

const containerName = "lando-livefilelogsapp-node";

describe("provider-lando live container-file logs", () => {
  test.skipIf(liveSocket === undefined)(
    "uses packaged helper payloads against real container files without fake log access",
    async () => {
      const appRoot = await mkdtemp(join(tmpdir(), "lando-live-file-logs-app-"));
      const plan = makePlan(appRoot);
      const socketPath = liveSocket?.socketPath;
      expect(socketPath).toBeTruthy();
      const logFileHelperPayloads = await Effect.runPromise(loadLogFileHelperPayloads());
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          socketPath: socketPath ?? "",
          logFileHelperPayloads,
        }),
      );
      const api = makePodmanApiClient(socketPath ?? "");

      expect(provider.capabilities.serviceLogSources).toBe(true);

      await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: false })));
      try {
        await execOk(
          provider,
          plan,
          `const fs = require('node:fs');
           fs.mkdirSync('/tmp/lando-live', { recursive: true });
           fs.writeFileSync('${sources.main.path}', 'finite-one\\nfinite-two\\n');
           fs.writeFileSync('${sources.tail.path}', 'tail-old\\ntail-new\\n');
           fs.writeFileSync('${sources.since.path}', '2026-05-14T00:00:00Z too-old\\n2026-05-14T00:00:02Z new-enough\\n');
           fs.writeFileSync('${sources.copytruncate.path}', '');
           fs.writeFileSync('${sources.rotate.path}', '');
           fs.writeFileSync('${sources.utf8.path}', '');
           fs.writeFileSync('${sources.partial.path}', 'partial-final');
           fs.writeFileSync('${sources.binary.path}', Buffer.concat([Buffer.from('binary-start-'), Buffer.alloc(70000, 0xff), Buffer.from('\\n')]));`,
        );

        const finite = await collectStage("finite main snapshot", fileLogs(provider, plan, sources.main));
        expect(finite.map((chunk) => [chunk.source, chunk.stream, chunk.line])).toEqual([
          [sources.main.id, "stderr", "finite-one"],
          [sources.main.id, "stderr", "finite-two"],
        ]);

        const missing = await collectStage(
          "finite missing optional",
          fileLogs(provider, plan, sources.missing),
        );
        expect(missing).toEqual([]);

        const tail = await collectStage(
          "finite tail source",
          fileLogs(provider, plan, sources.tail, { tail: 1 }),
        );
        expect(tail.map((chunk) => chunk.line)).toEqual(["tail-new"]);

        const since = await collectStage(
          "finite timestamped since source",
          fileLogs(provider, plan, sources.since, { since: "1778716801" }),
        );
        expect(since.map((chunk) => [chunk.line, chunk.timestamp?.toISOString()])).toEqual([
          ["new-enough", "2026-05-14T00:00:02.000Z"],
        ]);

        const copytruncatePromise = withTimeout(
          "copytruncate follow",
          collect(fileLogs(provider, plan, sources.copytruncate, { follow: true }).pipe(Stream.take(1))),
        );
        await execOk(
          provider,
          plan,
          `const fs = require('node:fs'); fs.truncateSync('${sources.copytruncate.path}', 0); fs.appendFileSync('${sources.copytruncate.path}', 'copytruncate-after\\n');`,
        );
        expect((await copytruncatePromise).map((chunk) => [chunk.source, chunk.stream, chunk.line])).toEqual([
          [sources.copytruncate.id, "stderr", "copytruncate-after"],
        ]);

        await execOk(
          provider,
          plan,
          `const fs = require('node:fs'); fs.appendFileSync('${sources.rotate.path}', 'old-inode-ready\\n');`,
        );
        let markRotateReady: (() => void) | undefined;
        const rotateReady = withTimeout(
          "rename-create rotation readiness",
          new Promise<void>((resolve) => {
            markRotateReady = resolve;
          }),
        );
        const rotatePromise = withTimeout(
          "rename-create rotation follow",
          collect(
            fileLogs(provider, plan, sources.rotate, { follow: true }).pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  if (chunk.line === "old-inode-ready") markRotateReady?.();
                }),
              ),
              Stream.take(3),
            ),
          ),
        );
        await rotateReady;
        await execOk(
          provider,
          plan,
          `const fs = require('node:fs'); fs.appendFileSync('${sources.rotate.path}', 'old-inode-drain\\n'); fs.renameSync('${sources.rotate.path}', '${sources.rotate.path}.1'); fs.writeFileSync('${sources.rotate.path}', 'new-inode\\n');`,
        );
        expect((await rotatePromise).map((chunk) => chunk.line)).toEqual([
          "old-inode-ready",
          "old-inode-drain",
          "new-inode",
        ]);

        const utf8Promise = withTimeout(
          "split utf8 follow",
          collect(fileLogs(provider, plan, sources.utf8, { follow: true }).pipe(Stream.take(1))),
        );
        await execOk(
          provider,
          plan,
          `const fs = require('node:fs'); fs.appendFileSync('${sources.utf8.path}', Buffer.from([0xe2])); setTimeout(() => fs.appendFileSync('${sources.utf8.path}', Buffer.from([0x98, 0x83, 0x0a])), 50);`,
        );
        expect((await utf8Promise).map((chunk) => chunk.line)).toEqual(["☃"]);

        const partial = await collectStage(
          "finite partial-line flush",
          fileLogs(provider, plan, sources.partial),
        );
        expect(partial.map((chunk) => chunk.line)).toEqual(["partial-final"]);

        const binary = await collectStage(
          "finite binary oversized bound",
          fileLogs(provider, plan, sources.binary),
        );
        expect(binary).toHaveLength(1);
        expect(binary[0]?.line.startsWith("binary-start-")).toBe(true);
        expect(binary[0]?.line).toContain("truncated");

        const merged = await collectStage(
          "finite console plus file merge",
          provider.logs(
            { app: plan.id, service: serviceName, plan },
            { follow: false, tail: 20, sources: [sources.main] },
          ),
        );
        expect(
          merged.some((chunk) => chunk.source === undefined && chunk.line === "live-console-ready"),
        ).toBe(true);
        expect(merged.some((chunk) => chunk.source === sources.main.id && chunk.line === "finite-one")).toBe(
          true,
        );
        expect(merged.every((chunk) => "line" in chunk && !("diagnostic" in chunk))).toBe(true);

        const helperProcesses = await execShellOk(
          provider,
          plan,
          "ps | grep lando-log-file-helper | grep -v grep || true",
        );
        expect(helperProcesses.trim()).toBe("");
      } finally {
        await Effect.runPromise(
          provider.destroy({ app: plan.id, plan }, { volumes: true, removeState: false }),
        );
        await rm(appRoot, { recursive: true, force: true });
      }

      const inspectAfterDestroy: PodmanHttpResponse = await Effect.runPromise(
        api.request?.({ method: "GET", path: `/containers/${containerName}/json` }) ??
          Effect.succeed({ status: 500, body: "missing request client" }),
      );
      expect(inspectAfterDestroy.status).toBe(404);
      console.log(
        `[live-container-file-logs] teardown receipt: ${containerName} inspect returned ${inspectAfterDestroy.status}; helper ps was empty before destroy`,
      );
    },
    120_000,
  );
});
