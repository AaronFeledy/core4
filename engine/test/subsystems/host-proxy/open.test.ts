import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { HostProxyOpenUrlSchemeError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { openerArgvFor } from "../../../src/services/host-opener.ts";
import { dispatchHostOpen } from "../../../src/subsystems/host-proxy/dispatch.ts";
import {
  DEFAULT_OPEN_SCHEMES,
  type HostProxyOpenRequest,
  openHostProxyTarget,
} from "../../../src/subsystems/host-proxy/open-target.ts";
import { createHostProxyRunLandoSession } from "../../../src/subsystems/host-proxy/transport.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "hostopen-test-"));
  roots.push(root);
  return root;
};
const mount = { containerRoot: "/app", hostRoot: "/srv/app" };
const recorder = (exitCode = 0) => {
  const calls: ProcessSpawnOptions[] = [];
  const layer = Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { exitCode, stdout: "", stderr: "" };
        }),
      stream: () => Stream.die("unused"),
      streamWithExit: () => Stream.die("unused"),
    }),
  );
  return { calls, layer };
};
const lifecycle = () => {
  const events: Array<{ readonly _tag: string }> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        registerValues: registerRedactionValues,
        payloadValues: () => Effect.succeed(() => []),
        forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.die("unused"),
        subscribeQueue: Effect.die("unused"),
        query: () => Effect.die("unused"),
        waitFor: () => Effect.die("unused"),
        waitForAny: () => Effect.die("unused"),
      }),
    ),
  );
  return { events, layer };
};

test.each([...DEFAULT_OPEN_SCHEMES])("opens %s URLs with one precise host argv target", async (scheme) => {
  const target = `${scheme}://example.com/x?a=1&b=two%20words`;
  const runner = recorder();
  await Effect.runPromise(
    openHostProxyTarget({ _tag: "openUrl", url: target }, mount).pipe(Effect.provide(runner.layer)),
  );
  expect(runner.calls).toEqual([
    {
      cmd:
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open",
      args: process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target],
    },
  ]);
});

test.each([
  "file:///etc/passwd",
  "FILE:///etc/passwd",
  "javascript:alert(1)",
  "ftp://example.com",
  "invalid",
])("rejects %s without launching an opener", async (url) => {
  const runner = recorder();
  const result = await Effect.runPromise(
    Effect.result(
      openHostProxyTarget({ _tag: "openUrl", url }, mount, ["file"]).pipe(Effect.provide(runner.layer)),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(HostProxyOpenUrlSchemeError);
  expect(runner.calls).toEqual([]);
});

test("service-level scheme extensions do not replace defaults", async () => {
  const runner = recorder();
  await Effect.runPromise(
    openHostProxyTarget({ _tag: "openUrl", url: "custom:abc" }, mount, ["custom"]).pipe(
      Effect.provide(runner.layer),
    ),
  );
  expect(runner.calls[0]?.args).toEqual(["custom:abc"]);
});

test("remaps a path with spaces and an in-mount symlink to its canonical host target", async () => {
  const root = await temp();
  await writeFile(join(root, "a b"), "readme");
  await symlink(join(root, "a b"), join(root, "link"));
  const runner = recorder();
  await Effect.runPromise(
    openHostProxyTarget(
      { _tag: "openPath", path: AbsolutePath.make("/app/link") },
      { containerRoot: "/app", hostRoot: root },
    ).pipe(Effect.provide(runner.layer)),
  );
  expect(runner.calls[0]?.args).toEqual(
    process.platform === "darwin"
      ? ["-R", join(root, "a b")]
      : process.platform === "win32"
        ? [`/select,${join(root, "a b")}`]
        : [root],
  );
});

test.each(["/etc/passwd", "/application/README", "/app/../README", "/app/escape", "/app/missing"])(
  "rejects outside, escaped, or missing path %s",
  async (path) => {
    const root = await temp();
    const outside = await temp();
    await writeFile(join(outside, "secret"), "secret");
    await symlink(join(outside, "secret"), join(root, "escape"));
    const runner = recorder();
    const result = await Effect.runPromise(
      Effect.result(
        openHostProxyTarget(
          { _tag: "openPath", path: AbsolutePath.make(path) },
          { containerRoot: "/app", hostRoot: root },
        ).pipe(Effect.provide(runner.layer)),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("HostProxyOpenPathError");
    expect(runner.calls).toEqual([]);
  },
);

test.each([0, 7])("publishes redacted pre/post events for opener exit %s", async (exitCode) => {
  const runner = recorder(exitCode);
  const recorded = lifecycle();
  await Effect.runPromise(registerRedactionValues(["hostopen-secret-123"]));
  const result = await Effect.runPromise(
    Effect.result(
      dispatchHostOpen(
        { _tag: "openUrl", url: "https://example.com/hostopen-secret-123" },
        {
          app: { kind: "user", id: "demo", root: AbsolutePath.make("/srv/app") },
          mountInfo: mount,
          callerService: "web",
          depth: 0,
          executor: (request, roots) =>
            openHostProxyTarget(request, roots).pipe(Effect.provide(runner.layer)),
        },
      ).pipe(Effect.provide(recorded.layer)),
    ),
  );
  expect(result._tag).toBe(exitCode === 0 ? "Success" : "Failure");
  if (result._tag === "Failure") expect(result.failure._tag).toBe("HostProxyOpenerError");
  expect(recorded.events.map((event) => event._tag)).toEqual(["pre-host-proxy-call", "post-host-proxy-call"]);
  expect(JSON.stringify(recorded.events)).not.toContain("hostopen-secret-123");
  expect(JSON.stringify(recorded.events)).not.toContain("https://example.com/");
  expect(recorded.events[1]).toMatchObject({ outcome: exitCode === 0 ? "success" : "failure" });
});

test("scheme rejection publishes a failure pair without executing", async () => {
  const runner = recorder();
  const recorded = lifecycle();
  await Effect.runPromise(
    Effect.result(
      dispatchHostOpen(
        { _tag: "openUrl", url: "file:///etc/passwd" },
        {
          app: { kind: "user", id: "demo", root: AbsolutePath.make("/srv/app") },
          mountInfo: mount,
          callerService: "web",
          depth: 0,
          executor: (request, roots) =>
            openHostProxyTarget(request, roots).pipe(Effect.provide(runner.layer)),
        },
      ).pipe(Effect.provide(recorded.layer)),
    ),
  );
  expect(recorded.events.map((event) => event._tag)).toEqual(["pre-host-proxy-call", "post-host-proxy-call"]);
  expect(recorded.events[1]).toMatchObject({
    outcome: "failure",
    failureDetail: "HostProxyOpenUrlSchemeError",
  });
  expect(runner.calls).toEqual([]);
});

test("uses the platform opener argv for macOS and Windows", () => {
  expect(openerArgvFor("darwin", "https://example.com/x")).toEqual(["open", "https://example.com/x"]);
  expect(openerArgvFor("win32", "https://example.com/?a=1&b=2")).toEqual([
    "rundll32.exe",
    "url.dll,FileProtocolHandler",
    "https://example.com/?a=1&b=2",
  ]);
});

test("serves openUrl/openPath over the authenticated transport without widening runLando", async () => {
  const root = await temp();
  const shim = join(root, "shim");
  await writeFile(shim, "fixture");
  const recorded = lifecycle();
  const calls: HostProxyOpenRequest[] = [];
  const session = await Effect.runPromise(
    createHostProxyRunLandoSession({
      app: { kind: "user", id: "demo", root: AbsolutePath.make(root) },
      mountInfo: { containerRoot: "/app", hostRoot: root },
      allowlist: [],
      callerService: "web",
      executor: () => Effect.die("runLando must not execute"),
      openExecutor: (request) =>
        request._tag === "openUrl" && request.url.startsWith("file:")
          ? Effect.fail(
              new HostProxyOpenUrlSchemeError({ message: "forbidden", remediation: "Use an app path." }),
            )
          : Effect.sync(() => {
              calls.push(request);
            }),
      paths: { userDataRoot: root, userCacheRoot: root, platform: "win32" },
      shimArtifactPath: shim,
    }).pipe(Effect.provide(recorded.layer)),
  );
  try {
    for (const request of [
      { _tag: "openUrl", url: "https://example.com" },
      { _tag: "openPath", path: AbsolutePath.make("/app/README") },
    ] satisfies HostProxyOpenRequest[]) {
      const response = await fetch(`${session.url}/${request._tag}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-lando-host-proxy-app": session.appId,
          "x-lando-host-proxy-session": session.sessionId,
        },
        body: JSON.stringify(request),
      });
      expect(await response.json()).toEqual({ _tag: "ok" });
    }
    expect(calls).toHaveLength(2);
    const forbidden = await fetch(`${session.url}/openUrl`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-lando-host-proxy-app": session.appId,
        "x-lando-host-proxy-session": session.sessionId,
      },
      body: JSON.stringify({ _tag: "openUrl", url: "file:///etc/passwd" }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      _tag: "error",
      code: "scheme-not-allowed",
      remediation: "Use an app path.",
    });
    const wrongMethod = await fetch(`${session.url}/openUrl`);
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toMatchObject({ _tag: "error", code: "internal" });
    const rejected = await fetch(`${session.url}/openUrl`, { method: "POST", body: "{}" });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ _tag: "error", code: "token-mismatch" });
  } finally {
    await session.close();
  }
});
