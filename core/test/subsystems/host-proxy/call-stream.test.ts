import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostProxyRunLandoSession,
  sendHostProxyRunLando,
} from "@lando/engine/subsystems/host-proxy/transport";
import type { RedactionService } from "@lando/redaction/service";
import { AppPlan } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { hostProxyChildExecutor } from "../../../src/cli/host-proxy/call-spawn";
import { WorkerInput } from "../../../src/cli/host-proxy/worker-config";
import { makePlan, redactionLayer, silentEventLayer } from "../../_support/host-proxy-open-fixtures";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const run = <A, E>(program: Effect.Effect<A, E, EventService | RedactionService>) =>
  Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer(), silentEventLayer()))));
const sessionFor = async (
  script: string,
  diagnostic?: Parameters<typeof createHostProxyRunLandoSession>[0]["diagnostic"],
  concurrency?: number,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-hp-stream-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "child.ts");
  const shim = join(root, "lando");
  await writeFile(entry, script);
  await writeFile(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const plan = { ...makePlan([], []), root };
  const input = Schema.decodeUnknownSync(WorkerInput)({
    app: { kind: "user", id: plan.id, root },
    plan: Schema.encodeUnknownSync(AppPlan)(plan),
    paths: {
      platform: "linux",
      userConfRoot: root,
      userDataRoot: root,
      userCacheRoot: root,
      systemPluginRoot: root,
    },
    shimArtifactPath: shim,
    configDigest: "test",
  });
  const session = await run(
    createHostProxyRunLandoSession({
      app: { ...input.app, root: input.plan.root },
      mountInfo: { containerRoot: "/app", hostRoot: root },
      allowlist: ["app:open"],
      callerService: "web",
      executor: hostProxyChildExecutor(input, [process.execPath, entry]),
      paths: { userDataRoot: root },
      shimArtifactPath: shim,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(concurrency === undefined ? {} : { concurrency }),
    }),
  );
  cleanup.push(session.close);
  return session;
};
const call = { argv: ["app:open", "--format=json"], cwd: "/app", tty: false };

test("streams raw chunks with independent split UTF-8 decoding, stderr, and exit passthrough", async () => {
  const session = await sessionFor(
    `process.stdout.write(new Uint8Array([0xe2])); await Bun.sleep(10); process.stderr.write("error\\n"); process.stdout.write(new Uint8Array([0x82,0xac])); process.stdout.write('{"ok":true}\\n'); process.exitCode=7;`,
  );
  const result = await run(sendHostProxyRunLando(session, call));
  expect(result).toEqual({ stdout: '€{"ok":true}\n', stderr: "error\n", exitCode: 7 });
});

test("invalid UTF-8 produces a single terminal transport error instead of replacement text", async () => {
  const session = await sessionFor("process.stdout.write(new Uint8Array([0xff]));");
  await expect(run(sendHostProxyRunLando(session, call))).rejects.toMatchObject({
    _tag: "HostProxyTransportUnavailableError",
  });
});

test("a slow reader backpressures large multi-chunk output until it resumes", async () => {
  let finished = false;
  const session = await sessionFor(`process.stdout.write("x".repeat(32*1024*1024));`, () => {
    finished = true;
  });
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: session.socketPath,
        path: "/runLando",
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-lando-host-proxy-app": session.appId,
          "x-lando-host-proxy-session": session.sessionId,
        },
      },
      (res) => {
        res.pause();
        resolve(res);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ _tag: "runLando", ...call }));
  });
  let bytes = 0;
  const ended = new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
    });
    response.once("end", resolve);
    response.once("error", reject);
  });
  response.pause();
  await Bun.sleep(75);
  expect(finished).toBe(false);
  response.resume();
  await ended;
  expect(bytes).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  expect(finished).toBe(true);
});

test("descendant-held stdio cannot prevent the direct child's exit frame", async () => {
  const session = await sessionFor(
    `Bun.spawn([process.execPath,"-e","setTimeout(()=>{},1500)"], {stdin:"ignore",stdout:"inherit",stderr:"inherit"}); process.stdout.write("parent\\n"); process.exit(9);`,
  );
  const start = performance.now();
  const result = await run(sendHostProxyRunLando(session, call));
  expect(result).toEqual({ stdout: "parent\n", stderr: "", exitCode: 9 });
  expect(performance.now() - start).toBeLessThan(1400);
});

test("disconnect interrupts promptly and holds the slot until the child is reaped", async () => {
  const reaped = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<number>();
  const session = await sessionFor(
    `process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),250)); process.stdout.write(String(process.pid)); setInterval(()=>{},1000);`,
    (entry) => {
      if (entry.outcome === "cancelled") reaped.resolve();
    },
    1,
  );
  const req = httpRequest(
    {
      socketPath: session.socketPath,
      path: "/runLando",
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-lando-host-proxy-app": session.appId,
        "x-lando-host-proxy-session": session.sessionId,
      },
    },
    (response) => {
      response.setEncoding("utf8");
      response.once("data", (chunk: string) => ready.resolve(Number(JSON.parse(chunk.trim()).chunk)));
    },
  );
  req.on("error", () => undefined);
  req.end(JSON.stringify({ _tag: "runLando", ...call }));
  const pid = await ready.promise;
  const start = performance.now();
  req.destroy();
  const saturated = await Effect.runPromiseExit(sendHostProxyRunLando(session, call));
  expect(saturated._tag).toBe("Failure");
  await reaped.promise;
  expect(performance.now() - start).toBeLessThan(1500);
  expect(() => process.kill(pid, 0)).toThrow();
});

test.each([-1, 0.5, 1e30, Number.NaN])("rejects invalid depth %s before spawning", async (depth) => {
  const session = await sessionFor(`throw new Error("must not spawn");`);
  await expect(run(sendHostProxyRunLando(session, call, { depth }))).rejects.toMatchObject({
    _tag: "HostProxyRecursionError",
  });
});

test("seventeenth concurrent call receives immediate backpressure", async () => {
  const admitted = Promise.withResolvers<void>();
  let count = 0;
  const session = await sessionFor(`process.stdout.write("ready"); setInterval(()=>{},1000);`);
  const requests = Array.from({ length: 16 }, () => {
    const req = httpRequest(
      {
        socketPath: session.socketPath,
        path: "/runLando",
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-lando-host-proxy-app": session.appId,
          "x-lando-host-proxy-session": session.sessionId,
        },
      },
      (res) => {
        res.once("data", () => {
          if (++count === 16) admitted.resolve();
        });
      },
    );
    req.on("error", () => undefined);
    req.end(JSON.stringify({ _tag: "runLando", ...call }));
    return req;
  });
  try {
    await admitted.promise;
    await expect(run(sendHostProxyRunLando(session, call))).rejects.toMatchObject({
      _tag: "HostProxyBackpressureError",
    });
  } finally {
    for (const req of requests) req.destroy();
  }
});
