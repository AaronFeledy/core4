import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import { HostProxyCommandNotAllowedError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import {
  RedactionService,
  type RedactionServiceShape,
  createStandaloneRedactor,
} from "../../../src/redaction/service.ts";
import {
  type HostProxyRunLandoExecutor,
  dispatchRunLando,
} from "../../../src/subsystems/host-proxy/dispatch.ts";
import { openOptionsFromRunLandoArgv } from "../../../src/subsystems/host-proxy/open-argv.ts";
import { buildRunLandoRequest } from "../../../src/subsystems/host-proxy/shim.ts";

const appRef = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/home/u/demo") };
const mount = { containerRoot: "/app", hostRoot: "/home/u/demo" };

const standaloneRedactionService: RedactionServiceShape = {
  forProfile: (_profile, options) => Effect.succeed(createStandaloneRedactor(_profile, options)),
};

const standaloneRedactionLayer = Layer.succeed(RedactionService, {
  ...standaloneRedactionService,
});

const recordingEvents = () => {
  const events: LandoEvent[] = [];
  const layer = Layer.succeed(EventService, {
    publish: (event: LandoEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die("unused"),
    waitFor: () => Effect.die("unused"),
  } as never);
  return { events, layer };
};

const okExecutor =
  (envelope: unknown, exitCode = 0): HostProxyRunLandoExecutor =>
  (_input) =>
    Effect.succeed({ envelope: envelope as never, exitCode });

const baseEnvelope = {
  apiVersion: "v4" as const,
  command: "app:open",
  ok: true,
  result: { app: "demo", targets: [], launch: "printed" as const },
  warnings: [],
  deprecations: [],
};

describe("openOptionsFromRunLandoArgv", () => {
  test("parses equals-form app:open flags", () => {
    const options = openOptionsFromRunLandoArgv(
      ["open", "--service=web", "--route=https://web.demo.lndo.site", "--format=json"],
      { tty: false },
    );

    expect(options).toEqual({
      service: "web",
      route: "https://web.demo.lndo.site",
      json: true,
      ttyPresent: false,
    });
  });

  test("parses -j as the universal JSON format shortcut", () => {
    const options = openOptionsFromRunLandoArgv(["open", "-j", "--print"], { tty: false });

    expect(options).toEqual({
      print: true,
      json: true,
      ttyPresent: false,
    });
  });

  test("keeps explicit text format ahead of later JSON shortcut", () => {
    const options = openOptionsFromRunLandoArgv(["open", "--format=text", "-j"], { tty: false });

    expect(options).toEqual({
      json: false,
      ttyPresent: false,
    });
  });

  test("rejects unsupported --format values", () => {
    expect(() => openOptionsFromRunLandoArgv(["open", "--format=xml"], { tty: false })).toThrow(
      'Unsupported result format value "xml" from flag.',
    );
  });
});

describe("dispatchRunLando", () => {
  test("dispatches an allowed command and returns the executor envelope + exit code", async () => {
    const { events, layer } = recordingEvents();
    let captured: { commandId: string; cwd: string; env: Readonly<Record<string, string>> } | undefined;
    const executor: HostProxyRunLandoExecutor = (input) => {
      captured = { commandId: input.commandId, cwd: input.cwd, env: input.env };
      return Effect.succeed({ envelope: baseEnvelope as never, exitCode: 0 });
    };
    const request = buildRunLandoRequest({ argv: ["open", "--print"], cwd: "/app/web", tty: false });

    const result = await Effect.runPromise(
      dispatchRunLando(request, {
        executor,
        allowlist: ["app:open"],
        mountInfo: mount,
        callerService: "web",
        depth: 0,
        app: appRef,
      }).pipe(Effect.provide(Layer.mergeAll(layer, standaloneRedactionLayer))),
    );

    expect(result.exitCode).toBe(0);
    expect(result.envelope).toEqual(baseEnvelope);
    expect(captured?.commandId).toBe("app:open");
    expect(captured?.cwd).toBe("/home/u/demo/web");
    expect(captured?.env.LANDO_HOST_PROXY_DEPTH).toBe("1");
    const tags = events.map((event) => event._tag);
    expect(tags).toContain("pre-host-proxy-call");
    expect(tags).toContain("post-host-proxy-call");
    const post = events.find((event) => event._tag === "post-host-proxy-call");
    if (post?._tag === "post-host-proxy-call") expect(post.outcome).toBe("success");
  });

  test("reconstructs host-proxy depth without forwarding container session material", async () => {
    const { layer } = recordingEvents();
    let capturedEnv: Readonly<Record<string, string>> | undefined;
    const executor: HostProxyRunLandoExecutor = (input) => {
      capturedEnv = input.env;
      return Effect.succeed({ envelope: baseEnvelope as never, exitCode: 0 });
    };
    const request = buildRunLandoRequest({
      argv: ["open", "--print"],
      cwd: "/app",
      tty: false,
      env: {
        LANDO_APP_NAME: "demo",
        LANDO_HOST_PROXY_TOKEN: "tok",
        LANDO_HOST_PROXY_SESSION: "session",
        LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock",
        LANDO_HOST_PROXY_URL: "http://127.0.0.1:1234",
        LANDO_HOST_PROXY_APP: "demo",
        LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
        LANDO_HOST_PROXY_SHIM: "/usr/local/bin/lando",
        LANDO_HOST_PROXY_DEPTH: "99",
      },
    });

    await Effect.runPromise(
      dispatchRunLando(request, {
        executor,
        allowlist: ["app:open"],
        mountInfo: mount,
        callerService: "web",
        depth: 2,
        app: appRef,
      }).pipe(Effect.provide(Layer.mergeAll(layer, standaloneRedactionLayer))),
    );

    expect(capturedEnv).toEqual({
      LANDO_APP_NAME: "demo",
      LANDO_HOST_PROXY_DEPTH: "3",
    });
  });

  test("rejects a command outside the allowlist and still publishes pre+post events", async () => {
    const { events, layer } = recordingEvents();
    const request = buildRunLandoRequest({ argv: ["destroy"], cwd: "/app", tty: false });

    const exit = await Effect.runPromiseExit(
      dispatchRunLando(request, {
        executor: okExecutor(baseEnvelope),
        allowlist: ["app:open"],
        mountInfo: mount,
        callerService: "web",
        depth: 0,
        app: appRef,
      }).pipe(Effect.provide(Layer.mergeAll(layer, standaloneRedactionLayer))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(HostProxyCommandNotAllowedError);
    }
    const tags = events.map((event) => event._tag);
    expect(tags).toContain("pre-host-proxy-call");
    expect(tags).toContain("post-host-proxy-call");
    const post = events.find((event) => event._tag === "post-host-proxy-call");
    if (post?._tag === "post-host-proxy-call") {
      expect(post.outcome).toBe("failure");
      expect(post.failureDetail).toBe("HostProxyCommandNotAllowedError");
    }
  });

  test("rejects app:open when it is stripped from the passed allowlist", async () => {
    const { layer } = recordingEvents();
    const request = buildRunLandoRequest({ argv: ["open", "--print"], cwd: "/app", tty: false });

    const exit = await Effect.runPromiseExit(
      dispatchRunLando(request, {
        executor: okExecutor(baseEnvelope),
        allowlist: [],
        mountInfo: mount,
        callerService: "web",
        depth: 0,
        app: appRef,
      }).pipe(Effect.provide(Layer.mergeAll(layer, standaloneRedactionLayer))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("never leaks a secret-bearing argv value into published events", async () => {
    const { events, layer } = recordingEvents();
    const request = buildRunLandoRequest({
      argv: ["open", "--route", "https://user:s3cr3tpass@demo.lndo.site"],
      cwd: "/app",
      tty: false,
    });

    await Effect.runPromise(
      dispatchRunLando(request, {
        executor: okExecutor(baseEnvelope),
        allowlist: ["app:open"],
        mountInfo: mount,
        callerService: "web",
        depth: 0,
        app: appRef,
      }).pipe(Effect.provide(Layer.mergeAll(layer, standaloneRedactionLayer))),
    );

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("s3cr3tpass");
  });

  test("never leaks a forwarded host-proxy token into events or failures", async () => {
    const { events, layer } = recordingEvents();
    const token = "hp-token-event-canary";
    const request = buildRunLandoRequest({
      argv: ["destroy"],
      cwd: "/app",
      tty: false,
      env: { LANDO_HOST_PROXY_TOKEN: token },
    });

    const exit = await Effect.runPromiseExit(
      dispatchRunLando(request, {
        executor: okExecutor(baseEnvelope),
        allowlist: ["app:open"],
        mountInfo: mount,
        callerService: "web",
        depth: 0,
        app: appRef,
      }).pipe(Effect.provide(Layer.mergeAll(layer, standaloneRedactionLayer))),
    );

    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(exit)).not.toContain(token);
  });
});
