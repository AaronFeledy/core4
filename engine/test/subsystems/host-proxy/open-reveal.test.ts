import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { ProcessExecError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import {
  HostProxyOpenerError,
  openHostTarget,
  revealArgvFor,
  revealHostPath,
} from "../../../src/services/host-opener.ts";
import { openHostProxyTarget } from "../../../src/subsystems/host-proxy/open-target.ts";
import { createHostProxyRunLandoSession } from "../../../src/subsystems/host-proxy/transport.ts";

const recordingRunner = (exitCode: number) => {
  const calls: ProcessSpawnOptions[] = [];
  const service = ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { exitCode, stdout: "", stderr: "" };
      }),
    stream: () => Stream.die("unused"),
    streamWithExit: () => Stream.die("unused"),
  });
  return { calls, service };
};

test.each([
  ["linux", "/app/a.desktop", false, ["xdg-open", "/app"]],
  ["linux", "/app/folder", true, ["xdg-open", "/app/folder"]],
  ["darwin", "/app/x.command", false, ["open", "-R", "/app/x.command"]],
  ["darwin", "/app/Foo.app", true, ["open", "-R", "/app/Foo.app"]],
  ["win32", "C:\\app\\evil.exe", false, ["explorer.exe", "/select,C:\\app\\evil.exe"]],
  ["win32", "C:\\app\\folder", true, ["explorer.exe", "/select,C:\\app\\folder"]],
] satisfies Array<readonly [NodeJS.Platform, string, boolean, readonly [string, ...string[]]]>)(
  "reveals %s target %s without launching it",
  (platform, target, directory, expected) => {
    expect(revealArgvFor(platform, target, directory)).toEqual(expected);
  },
);

test("Windows reveal accepts Explorer exit 1 but URL opening still fails on a nonzero exit", async () => {
  const runner = recordingRunner(1);
  await Effect.runPromise(
    revealHostPath("C:\\app\\evil.bat", false, { platform: "win32" }).pipe(
      Effect.provideService(ProcessRunner, runner.service),
    ),
  );
  const result = await Effect.runPromise(
    Effect.result(
      openHostTarget("https://example.com/x", { platform: "win32" }).pipe(
        Effect.provideService(ProcessRunner, runner.service),
      ),
    ),
  );
  expect(runner.calls).toEqual([
    { cmd: "explorer.exe", args: ["/select,C:\\app\\evil.bat"] },
    { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://example.com/x"] },
  ]);
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure).toMatchObject({ _tag: "HostProxyOpenerError", operation: "openUrl", exitCode: 1 });
});

test("macOS reveals a Foo.app directory using -R", async () => {
  const runner = recordingRunner(0);
  await Effect.runPromise(
    revealHostPath("/app/Foo.app", true, { platform: "darwin" }).pipe(
      Effect.provideService(ProcessRunner, runner.service),
    ),
  );
  expect(runner.calls).toEqual([{ cmd: "open", args: ["-R", "/app/Foo.app"] }]);
});

test.skipIf(process.platform !== "linux")(
  "openPath reveals a Linux file's parent and a directory itself",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hostopen-reveal-"));
    const runner = recordingRunner(0);
    try {
      await writeFile(join(root, "evil.desktop"), "[Desktop Entry]\nExec=host-code\n");
      await mkdir(join(root, "folder"));
      for (const path of ["/app/evil.desktop", "/app/folder"]) {
        await Effect.runPromise(
          openHostProxyTarget(
            { _tag: "openPath", path: AbsolutePath.make(path) },
            { containerRoot: "/app", hostRoot: root },
          ).pipe(Effect.provideService(ProcessRunner, runner.service)),
        );
      }
      expect(runner.calls).toEqual([
        { cmd: "xdg-open", args: [root] },
        { cmd: "xdg-open", args: [join(root, "folder")] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Windows reveal spawn failure is a tagged opener error, not a transport failure", async () => {
  const runner = recordingRunner(0);
  const result = await Effect.runPromise(
    Effect.result(
      revealHostPath("C:\\app\\evil.exe", false, { platform: "win32" }).pipe(
        Effect.provideService(ProcessRunner, {
          ...runner.service,
          run: () => Effect.fail(new ProcessExecError({ message: "missing", cmd: "explorer.exe" })),
        }),
      ),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toMatchObject({
      _tag: "HostProxyOpenerError",
      opener: "explorer.exe",
      operation: "revealPath",
    });
    expect(result.failure.remediation).toBeTruthy();
    expect("socketPath" in result.failure).toBe(false);
  }
});

test("opener failure retains its remediation and classification over the host-proxy wire", async () => {
  const root = await mkdtemp(join(tmpdir(), "hostopen-failure-"));
  const events: Array<{ readonly _tag: string }> = [];
  const services = Layer.mergeAll(
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        ...makeRedactionService(),
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
  try {
    const shim = join(root, "shim");
    await writeFile(shim, "fixture");
    const session = await Effect.runPromise(
      createHostProxyRunLandoSession({
        app: { kind: "user", id: "demo", root: AbsolutePath.make(root) },
        mountInfo: { containerRoot: "/app", hostRoot: root },
        allowlist: [],
        callerService: "web",
        executor: () => Effect.die("unused"),
        openExecutor: () =>
          Effect.fail(
            new HostProxyOpenerError({
              message: "The host opener failed.",
              opener: "xdg-open",
              operation: "openUrl",
              remediation: "Install a host browser.",
            }),
          ),
        paths: { userDataRoot: root, userCacheRoot: root, platform: "win32" },
        shimArtifactPath: shim,
      }).pipe(Effect.provide(services)),
    );
    try {
      const response = await fetch(`${session.url}/openUrl`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-lando-host-proxy-app": session.appId,
          "x-lando-host-proxy-session": session.sessionId,
        },
        body: JSON.stringify({ _tag: "openUrl", url: "https://example.com" }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        _tag: "error",
        code: "internal",
        message: "The host opener failed.",
        remediation: "Install a host browser.",
      });
      expect(events[1]).toMatchObject({
        _tag: "post-host-proxy-call",
        outcome: "failure",
        failureDetail: "HostProxyOpenerError",
      });
    } finally {
      await session.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
