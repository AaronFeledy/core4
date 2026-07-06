import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";

import { HostProxyCommandNotAllowedError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "../../../src/redaction/service.ts";
import {
  type HostProxyRunLandoExecutor,
  dispatchRunLando,
} from "../../../src/subsystems/host-proxy/dispatch.ts";
import { openOptionsFromRunLandoArgv } from "../../../src/subsystems/host-proxy/open-argv.ts";
import { buildRunLandoRequest } from "../../../src/subsystems/host-proxy/shim.ts";

const appRef = { kind: "user" as const, id: "demo", root: "/home/u/demo" };
const mount = { containerRoot: "/app", hostRoot: "/home/u/demo" };

const standaloneRedactionLayer = Layer.succeed(RedactionService, {
  forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
} as never);

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
});

describe("dispatchRunLando", () => {
  test("dispatches an allowed command and returns the executor envelope + exit code", async () => {
    const { events, layer } = recordingEvents();
    let captured: { commandId: string; cwd: string } | undefined;
    const executor: HostProxyRunLandoExecutor = (input) => {
      captured = { commandId: input.commandId, cwd: input.cwd };
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
    const tags = events.map((event) => event._tag);
    expect(tags).toContain("pre-host-proxy-call");
    expect(tags).toContain("post-host-proxy-call");
    const post = events.find((event) => event._tag === "post-host-proxy-call");
    if (post?._tag === "post-host-proxy-call") expect(post.outcome).toBe("success");
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
});
