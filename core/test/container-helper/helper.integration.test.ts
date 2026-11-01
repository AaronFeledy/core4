import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Predicate, Stream } from "effect";

import { logFileHelperCleanupArgv, logFileHelperExecArgv } from "@lando/container-runtime/container-helper";
import { AGENT_CONTEXT_ENV_ALLOWLIST } from "@lando/engine/config/agent-env";
import type { HostProxyRunLandoExecutorInput } from "@lando/engine/subsystems/host-proxy/dispatch";
import { createHostProxyRunLandoSession } from "@lando/engine/subsystems/host-proxy/transport";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { resolveContainerHelper } from "../../src/container-helper/assets.ts";

// Drives the real Go helper built by `bun run build:container-helper` so the
// link-time env policy and both wire protocols stay in sync with TypeScript.
const hostTarget = { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" } as const;
const helperPath = async (): Promise<string> =>
  (await Effect.runPromise(resolveContainerHelper(hostTarget, { standalone: false, env: process.env }))).path;

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-container-helper-"));
  tempDirs.push(dir);
  return dir;
};

/** The client role is selected by the invoked name, as in a container's /usr/local/bin/lando. */
const landoClient = async (role = "lando"): Promise<string> => {
  const link = join(await tempRoot(), role);
  await symlink(await helperPath(), link);
  return link;
};

const credentialsFile = async (): Promise<string> => {
  const path = join(await tempRoot(), "credentials");
  await writeFile(
    path,
    JSON.stringify({ version: 1, app: "demo", session: "session-id", token: "secret-token" }),
    { mode: 0o444 },
  );
  return path;
};

const captureRunLando = async (
  extraEnv: Readonly<Record<string, string>>,
  responseExitCode = 0,
): Promise<{ readonly body: Readonly<Record<string, unknown>>; readonly exitCode: number }> => {
  const captured = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed: unknown = JSON.parse(body);
      if (!Predicate.isObject(parsed)) {
        captured.reject(new Error("Expected an object request body"));
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(
        `${JSON.stringify({ kind: "stdout", chunk: "hello" })}\n${JSON.stringify({ kind: "exit", code: responseExitCode })}\n`,
      );
      captured.resolve(parsed);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("Expected a TCP address");
    const proc = Bun.spawn({
      cmd: [await landoClient(), "open", "--print"],
      cwd: "/tmp",
      env: {
        LANDO_HOST_PROXY_URL: `http://127.0.0.1:${address.port}`,
        LANDO_HOST_PROXY_CREDENTIALS_FILE: await credentialsFile(),
        LANDO_HOST_PROXY_DEPTH: "0",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(10_000),
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout).toBe("hello");
    return { body: await captured.promise, exitCode };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe.skipIf(process.platform !== "linux")("host-proxy client role", () => {
  test.each([
    [
      "xdg-open",
      "https://example.com/x?a=1&b=two",
      { _tag: "openUrl", url: "https://example.com/x?a=1&b=two" },
    ],
    ["open", "mailto:dev@example.com", { _tag: "openUrl", url: "mailto:dev@example.com" }],
    ["xdg-open", "./README", { _tag: "openPath", path: "/tmp/README" }],
  ])("%s sends the authenticated opener request for %s", async (role, target, expected) => {
    const captured = Promise.withResolvers<unknown>();
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        captured.resolve({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.end('{"_tag":"ok"}');
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new TypeError("Expected TCP address");
      const child = Bun.spawn([await landoClient(role), target], {
        cwd: "/tmp",
        env: {
          LANDO_HOST_PROXY_URL: `http://127.0.0.1:${address.port}`,
          LANDO_HOST_PROXY_CREDENTIALS_FILE: await credentialsFile(),
          SECRET: "never-forwarded",
        },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(10_000),
      });
      expect(await child.exited).toBe(0);
      expect(await captured.promise).toEqual({
        path: `/${expected._tag}`,
        auth: "Bearer secret-token",
        body: expected,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("sends runLando with argv and cwd and exits with the host exit code", async () => {
    const { body, exitCode } = await captureRunLando({}, 3);
    expect(exitCode).toBe(3);
    expect(body).toMatchObject({ _tag: "runLando", argv: ["open", "--print"], cwd: "/tmp", tty: false });
  });

  test("forwards every engine agent marker", async () => {
    const hostEnv = Object.fromEntries(
      AGENT_CONTEXT_ENV_ALLOWLIST.map((name) => [name, name === "GROK_AGENT" ? "1" : `host-${name}`]),
    );
    expect((await captureRunLando(hostEnv)).body.env).toEqual(hostEnv);
  });

  test("omits session env and anything outside the policy", async () => {
    const { body } = await captureRunLando({
      LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
      LANDO_HOST_PROXY_TRANSPORT: "tcp-host-gateway",
      LANDO_APP_NAME: "demo",
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
      SECRET_TOKEN: "do-not-forward",
    });
    expect(body.env).toEqual({
      LC_ALL: "en_US.UTF-8",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      OPENCODE: "1",
    });
  });

  test("forwards GROK_AGENT only when it is 1", async () => {
    expect((await captureRunLando({ GROK_AGENT: "1" })).body.env).toEqual({ GROK_AGENT: "1" });
    expect((await captureRunLando({ GROK_AGENT: "/home/me/.grok" })).body.env).toEqual({});
  });

  test("names the missing transport env", async () => {
    const proc = Bun.spawn({
      cmd: [await landoClient(), "version"],
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(exitCode).toBe(127);
    expect(stderr).toBe("Missing LANDO_HOST_PROXY_SOCKET or LANDO_HOST_PROXY_URL for host-proxy runLando.\n");
  });
});

describe.skipIf(process.platform !== "linux")("log-file role", () => {
  test("answers stat, open, and read over stdio", async () => {
    const file = join(await tempRoot(), "app.log");
    await writeFile(file, "line-1\nline-2\n");
    const commands = [
      { op: "stat", path: file },
      { op: "open", path: file },
      { op: "read", offset: "7", maxBytes: 100 },
      { op: "close" },
    ];
    const proc = Bun.spawn({
      cmd: [...logFileHelperExecArgv(await helperPath())],
      stdin: new Blob([commands.map((command) => `${JSON.stringify(command)}\n`).join("")]),
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(exitCode).toBe(0);
    const [stat, open, read, close] = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(stat).toMatchObject({ ok: true, stat: { size: "14" } });
    expect(open).toMatchObject({ ok: true, stat: { size: "14" } });
    expect(read).toEqual({
      ok: true,
      bytes: Buffer.from("line-2\n").toString("base64"),
      nextOffset: "14",
      eof: true,
    });
    expect(close).toEqual({ ok: true });
  });

  test("refuses to clean up a path outside its install directory", async () => {
    const proc = Bun.spawn({
      cmd: [...logFileHelperCleanupArgv(await helperPath(), "/tmp")],
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: false, code: "EPROTO", message: "invalid helper cleanup path" });
  });
});

const sessionLayers = Layer.mergeAll(
  Layer.succeed(RedactionService, makeRedactionService()),
  Layer.succeed(
    EventService,
    EventService.of({
      publish: () => Effect.void,
      subscribe: () => Stream.die("unused"),
      subscribeQueue: Effect.die("unused"),
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.die("unused"),
      query: () => Effect.die("unused"),
      waitFor: () => Effect.die("unused"),
    }),
  ),
);

describe.skipIf(process.platform !== "linux")("host-proxy client against a real host session", () => {
  test("installs as the session client and forwards argv, remapped cwd, tty, and filtered env", async () => {
    let captured: HostProxyRunLandoExecutorInput | undefined;
    const session = await Effect.runPromise(
      createHostProxyRunLandoSession({
        app: { kind: "user", id: "demo", root: AbsolutePath.make("/srv/apps/demo") },
        mountInfo: { containerRoot: "/app", hostRoot: "/srv/apps/demo" },
        allowlist: ["app:open"],
        callerService: "web",
        executor: (request) => {
          captured = request;
          return Effect.succeed({ stdout: "https://demo.lndo.site\n", stderr: "", exitCode: 0 });
        },
        paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
        shimArtifactPath: await helperPath(),
        providerId: "lando",
      }).pipe(Effect.provide(sessionLayers)),
    );
    try {
      const client = join(await tempRoot(), "lando");
      await symlink(session.shimPath, client);
      const proc = Bun.spawn({
        cmd: [client, "open", "--print"],
        cwd: "/tmp",
        env: {
          LANDO_HOST_PROXY_SOCKET: session.socketPath ?? "",
          LANDO_HOST_PROXY_CREDENTIALS_FILE: join(dirname(session.shimPath), "credentials"),
          LANDO_HOST_PROXY_CALLER: "web",
          LANG: "C.UTF-8",
          OPENCODE: "1",
          SECRET_TOKEN: "do-not-forward",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toBe("https://demo.lndo.site\n");
      expect(captured).toMatchObject({
        argv: ["open", "--print"],
        commandId: "app:open",
        cwd: "/srv/apps/demo",
        tty: false,
        env: { LANDO_HOST_PROXY_DEPTH: "1", LANG: "C.UTF-8", OPENCODE: "1" },
        app: { kind: "user", id: "demo", root: "/srv/apps/demo" },
        mount: { containerRoot: "/app", hostRoot: "/srv/apps/demo" },
        callerService: "web",
        depth: 0,
      });
    } finally {
      await session.close();
    }
  });
});
