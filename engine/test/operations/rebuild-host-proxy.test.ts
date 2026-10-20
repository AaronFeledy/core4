import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Exit, Schema } from "effect";
import * as composition from "../../src/composition.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { startDetachedHostProxyWorker } from "../../src/subsystems/host-proxy/detached-worker.ts";
import type { HostProxyWorkerSpawner } from "../../src/subsystems/host-proxy/worker-process.ts";
import { readWorkerRecord, workerStatePath } from "../../src/subsystems/host-proxy/worker-state.ts";
import * as worker from "../../src/subsystems/host-proxy/worker.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";
const ensureWorker = startDetachedHostProxyWorker;

test("selected rebuild overlays the running host-proxy session and requests adoption with the full plan", async () => {
  // Given an eligible selected service and a separate unselected service.
  const selected: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        extensions: { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
      },
      [ServiceName.make("other")]: { ...web, name: ServiceName.make("other"), primary: false },
    },
  };
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: selected,
    onApply: (value) => {
      applied.push(value);
    },
  });
  const prepare = spyOn(composition, "prepareHostProxyShimArtifact").mockReturnValue(Effect.succeed("/shim"));
  const ensure = spyOn(worker, "startDetachedHostProxyWorker").mockReturnValue(
    Effect.succeed({
      appId: selected.id,
      sessionId: "running-session",
      token: "running-bearer",
      controlToken: "running-control",
      socketPath: "/running/host-proxy.sock",
      shimPath: "/running/lando",
      transport: "unix-socket",
      closed: new Promise(() => undefined),
      close: async () => undefined,
    }),
  );
  try {
    // When the selected rebuild uses the running session returned by ensure.
    await Effect.runPromise(
      rebuildApp(
        { services: [web.name] },
        {
          plan: selected,
          root: selected.root,
          app: { kind: "user", id: selected.id, root: selected.root },
          landofile: { name: selected.name, services: {} },
        },
      ).pipe(Effect.provide(harness.layer)),
    );
    // Then the full worker plan is retained while only the selected service is applied.
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({ plan: selected, reusePolicy: "adopt" });
    expect(Object.keys(applied[0]?.services ?? {})).toEqual([web.name]);
    expect(applied[0]?.services[web.name]?.environment).toMatchObject({
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_SESSION: "running-session",
      LANDO_HOST_PROXY_TOKEN: "running-bearer",
    });
    expect(applied[0]?.services[web.name]?.mounts).toContainEqual(
      expect.objectContaining({
        type: "bind",
        source: "/running/host-proxy.sock",
        target: "/run/lando/host-proxy.sock",
      }),
    );
    expect(JSON.stringify(harness.events)).not.toContain("running-bearer");
    expect(JSON.stringify(harness.events)).not.toContain("running-control");
  } finally {
    ensure.mockRestore();
    prepare.mockRestore();
    await rm(harness.userDataRoot, { recursive: true, force: true });
  }
});

test.each(["existing", "missing", "failed-adopt", "failed-fresh", "configure-rejected"] as const)(
  "selected rebuild uses authenticated ensure for %s worker",
  async (state) => {
    const selected: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          extensions: { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } },
        },
        [ServiceName.make("other")]: { ...web, name: ServiceName.make("other"), primary: false },
      },
    };
    const applied: AppPlan[] = [];
    const harness = makeHarness({
      plannedApp: selected,
      onApply: (value) => {
        applied.push(value);
      },
      ...(state.startsWith("failed") ? { applyEffect: Effect.die(new Error("apply failed")) } : {}),
    });
    const app = { kind: "user" as const, id: selected.id, root: selected.root };
    const paths = makeLandoPaths({ userDataRoot: harness.userDataRoot });
    const shim = join(harness.userDataRoot, "shim");
    await writeFile(shim, "shim");
    const access = await Effect.runPromise(
      Effect.scoped(PrivateFileAccessService.pipe(Effect.provide(PrivateFileAccessService.layer))),
    );
    let spawns = 0;
    let terminations = 0;
    let shutdowns = 0;
    const configuredPlans: unknown[] = [];
    const servers: ReturnType<typeof createServer>[] = [];
    const spawnWorker: HostProxyWorkerSpawner = (spec) => {
      spawns++;
      const pid = 1_000_000_000 + spawns;
      const sessionId = `session-${spawns}`;
      const token = `bearer-${spawns}`;
      const controlToken = `control-${spawns}`;
      const socketPath = join(dirname(workerStatePath(app, paths.roots)), "host-proxy.sock");
      let configDigest = "";
      const server = createServer((request, response) => {
        if (
          request.headers["x-lando-host-proxy-control"] !== controlToken ||
          request.headers.authorization !== `Bearer ${token}` ||
          request.headers["x-lando-host-proxy-session"] !== sessionId ||
          request.headers["x-lando-host-proxy-app"] !== app.id
        ) {
          response.writeHead(401).end();
          return;
        }
        if (request.method === "POST" && request.url === "/_lando/host-proxy/configure") {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            configuredPlans.push(JSON.parse(body));
            response.writeHead(state === "configure-rejected" && pid === 1_000_000_001 ? 400 : 200).end();
          });
          return;
        }
        if (request.method === "POST" && request.url === "/_lando/host-proxy/shutdown") {
          shutdowns++;
          response.writeHead(202).end();
          server.close();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            appId: app.id,
            appRoot: app.root,
            providerId: selected.provider,
            pid,
            sessionId,
            transport: "unix-socket",
            protocolVersion: 2,
            configDigest,
          }),
        );
      });
      servers.push(server);
      return {
        pid,
        argv: spec.argv,
        writeStdin: async (value) => {
          configDigest = Schema.decodeUnknownSync(Schema.Struct({ configDigest: Schema.String }))(
            JSON.parse(value),
          ).configDigest;
          await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
          });
          await chmod(socketPath, 0o600);
        },
        readReady: async () => ({
          _tag: "ready",
          appId: app.id,
          sessionId,
          token,
          controlToken,
          socketPath,
          shimPath: shim,
          transport: "unix-socket",
        }),
        terminate: async () => {
          terminations++;
          server.close();
          await rm(dirname(socketPath), { recursive: true, force: true });
        },
      };
    };
    const entry = spyOn(composition, "hostProxyWorkerEntry").mockReturnValue({
      execPath: process.execPath,
      entryPath: undefined,
      bunSourceEntryPath: "/fixture/worker.ts",
    });
    const prepare = spyOn(composition, "prepareHostProxyShimArtifact").mockReturnValue(Effect.succeed(shim));
    const ensure = spyOn(worker, "startDetachedHostProxyWorker").mockImplementation((options) =>
      ensureWorker({ ...options, spawnWorker }),
    );
    try {
      if (state === "existing" || state === "failed-adopt" || state === "configure-rejected")
        await Effect.runPromise(
          ensureWorker({
            app,
            plan: { ...selected, name: "running-config" },
            paths: { ...paths.roots, platform: paths.platform },
            shimArtifactPath: shim,
            privateFileAccess: access,
            spawnWorker,
          }),
        );
      const before = await Effect.runPromise(readWorkerRecord(app, paths.roots));
      const exit = await Effect.runPromiseExit(
        rebuildApp(
          { services: [web.name] },
          {
            plan: selected,
            root: selected.root,
            app,
            landofile: { name: selected.name, services: {} },
          },
        ).pipe(Effect.provide(harness.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(state.startsWith("failed"));
      expect(applied[0]?.services[web.name]?.environment.LANDO_HOST_PROXY_TOKEN).toBe(
        state === "configure-rejected" ? "bearer-2" : (before?.token ?? "bearer-1"),
      );
      expect(applied[0]?.services[web.name]?.environment.LANDO_HOST_PROXY_SOCKET).toBe(
        "/run/lando/host-proxy.sock",
      );
      expect(spawns).toBe(state === "configure-rejected" ? 2 : 1);
      expect(terminations).toBe(0);
      expect(shutdowns).toBe(state === "configure-rejected" ? 1 : 0);
      if (before !== undefined)
        expect(configuredPlans).toContainEqual(Schema.encodeUnknownSync(AppPlan)(selected));
      const record = await Effect.runPromise(readWorkerRecord(app, paths.roots));
      expect(record?.sessionId).toBe(
        state === "configure-rejected" ? "session-2" : (before?.sessionId ?? "session-1"),
      );
      if (state === "missing") {
        await Effect.runPromise(
          ensureWorker({
            app,
            plan: selected,
            paths: { ...paths.roots, platform: paths.platform },
            shimArtifactPath: shim,
            shimTarget: { os: "linux", arch: "x64" },
            privateFileAccess: access,
            spawnWorker,
          }),
        );
        expect(spawns).toBe(1);
      }
      expect(JSON.stringify(harness.events)).not.toContain("bearer-1");
      expect(JSON.stringify(harness.events)).not.toContain("control-1");
    } finally {
      ensure.mockRestore();
      prepare.mockRestore();
      entry.mockRestore();
      for (const server of servers) server.close();
      await rm(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
