import { describe, expect, test } from "bun:test";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { HostProxyCommandNotAllowedError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";

import {
  type HostProxyRunLandoExecutor,
  dispatchRunLando,
} from "@lando/engine/subsystems/host-proxy/dispatch";
import { buildRunLandoRequest } from "@lando/engine/subsystems/host-proxy/shim";
import { type OpenAppOptions, OpenAppResultSchema } from "../../src/cli/commands/open.ts";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../../src/cli/generated/host-proxy-allowlist.ts";
import { runOpenForHostProxy } from "../../src/cli/host-proxy/dispatch.ts";
import {
  commandServices,
  hostSideEnvelope,
  makePlan,
  recordingEventLayer,
  redactionLayer,
  route,
  silentEventLayer,
} from "../_support/host-proxy-open-fixtures.ts";

const appRef = { kind: "user" as const, id: "myapp", root: AbsolutePath.make("/srv/apps/myapp") };
const mount = { containerRoot: "/app", hostRoot: "/srv/apps/myapp" };

const roundTrip = (
  plan: AppPlan,
  argv: ReadonlyArray<string>,
  extras: {
    readonly allowlist?: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly tty?: boolean;
    readonly httpsPort?: number;
  } = {},
) => {
  const { events, layer } = recordingEventLayer();
  const executor: HostProxyRunLandoExecutor = (input) =>
    runOpenForHostProxy(plan, input).pipe(
      Effect.provide(commandServices(silentEventLayer(), extras.httpsPort)),
    );
  const request = buildRunLandoRequest({
    argv: [...argv],
    cwd: extras.cwd ?? "/app",
    tty: extras.tty ?? false,
  });
  const program = dispatchRunLando(request, {
    executor,
    allowlist: extras.allowlist ?? HOST_PROXY_RUNLANDO_ALLOWLIST,
    mountInfo: mount,
    callerService: "web",
    depth: 0,
    app: appRef,
  }).pipe(Effect.provide(Layer.mergeAll(layer, redactionLayer())));
  return { events, exit: Effect.runPromiseExit(program) };
};

const httpsPlan = () =>
  makePlan([route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" })], ["web"]);

const withStdoutTty = async <Value>(tty: boolean, run: () => Promise<Value>): Promise<Value> => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: tty });
  try {
    return await run();
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", descriptor);
  }
};

describe("in-container lando open host-proxy round-trip", () => {
  test("host dispatch retains typed inspection failure and cleanup defect in its envelope", async () => {
    // Given a provider inspection failure with a simultaneous cleanup defect.
    const primary = new ProviderUnavailableError({
      providerId: "test",
      operation: "inspect",
      message: "runtime inspection failed",
      remediation: "Repair runtime.",
    });
    const secondary = new Error("inspection cleanup failed");
    const provider = {
      ...TestRuntimeProvider,
      inspect: () => Effect.failCause(Cause.combine(Cause.fail(primary), Cause.die(secondary))),
    };
    // When the host gathers connections before opening a target.
    const result = await Effect.runPromise(
      runOpenForHostProxy(httpsPlan(), {
        commandId: "app:open",
        argv: ["open"],
        cwd: "/srv/apps/myapp",
        tty: false,
        env: {},
      }).pipe(Effect.provide(commandServices(silentEventLayer(), 443, provider))),
    );
    // Then both failure roles survive the machine envelope.
    expect(result.exitCode).toBe(1);
    expect(result.envelope.error).toEqual({
      _tag: "ProviderUnavailableError",
      providerId: "test",
      operation: "inspect",
      message: "runtime inspection failed",
      remediation: "Repair runtime.",
      additionalErrors: [
        {
          _tag: "LandoInternalError",
          role: "peer",
          message: "inspection cleanup failed",
          remediation: expect.stringContaining("--debug"),
        },
      ],
    });
  });
  test("an unobserved hostname fails closed instead of guessing an ingress port", async () => {
    const plan = makePlan(
      [route({ hostname: "unstarted.lndo.site", scheme: "https", service: "web" })],
      ["web"],
    );
    const result = await roundTrip(plan, ["open", "--print"]).exit;
    if (!Exit.isSuccess(result)) throw new Error("round-trip failed");
    expect(result.value.exitCode).toBe(1);
    expect(result.value.envelope.error?._tag).toBe("OpenTargetUnresolvedError");
  });

  test("--print round-trip envelope + exit code equal host-side app:open", async () => {
    const plan = httpsPlan();
    const options: OpenAppOptions = { print: true, ttyPresent: false };
    const host = await hostSideEnvelope(plan, options);

    const { exit } = roundTrip(plan, ["open", "--print"]);
    const result = await exit;
    expect(Exit.isSuccess(result)).toBe(true);
    if (!Exit.isSuccess(result)) return;

    expect(result.value.exitCode).toBe(host.exitCode);
    expect(result.value.envelope).toEqual(host.envelope);
    expect(result.value.envelope.ok).toBe(true);
  });

  test("in-container open prints the acquired nondefault HTTPS port", async () => {
    const { exit } = roundTrip(httpsPlan(), ["open", "--print"], { httpsPort: 4433 });
    const result = await exit;
    if (!Exit.isSuccess(result)) throw new Error("round-trip failed");
    expect(result.value.exitCode).toBe(0);
    const body = Schema.decodeUnknownSync(OpenAppResultSchema)(result.value.envelope.result);
    expect(body?.targets?.[0]?.url).toBe("https://web.myapp.lndo.site:4433");
  });

  test("headless degradation round-trips identically to host-side", async () => {
    const plan = httpsPlan();
    // Headless: no display env, so openForPlan degrades to printing.
    const previousDisplay = process.env.DISPLAY;
    const previousWayland = process.env.WAYLAND_DISPLAY;
    const displayKey = "DISPLAY";
    const waylandKey = "WAYLAND_DISPLAY";
    delete process.env[displayKey];
    delete process.env[waylandKey];
    try {
      const options: OpenAppOptions = { platform: "linux", env: {}, ttyPresent: false };
      const host = await hostSideEnvelope(plan, options);
      const hostResult = Schema.decodeUnknownSync(OpenAppResultSchema)(host.envelope.result);
      expect(hostResult?.launch).toBe("headless-degraded");

      const { exit } = roundTrip(plan, ["open"]);
      const result = await exit;
      if (!Exit.isSuccess(result)) throw new Error("round-trip failed");
      expect(result.value.exitCode).toBe(host.exitCode);
      expect(result.value.envelope).toEqual(host.envelope);
    } finally {
      if (previousDisplay !== undefined) process.env.DISPLAY = previousDisplay;
      if (previousWayland !== undefined) process.env.WAYLAND_DISPLAY = previousWayland;
    }
  });

  test("json explicit selection uses host stdout TTY, not container TTY", async () => {
    await withStdoutTty(false, async () => {
      const plan = httpsPlan();
      const previousDisplay = process.env.DISPLAY;
      process.env.DISPLAY = ":99";
      try {
        const host = await hostSideEnvelope(plan, { service: "web", json: true, ttyPresent: false });
        const hostResult = Schema.decodeUnknownSync(OpenAppResultSchema)(host.envelope.result);
        expect(hostResult?.launch).toBe("printed");

        const { exit } = roundTrip(plan, ["open", "--service", "web", "--format=json"], { tty: true });
        const result = await exit;
        if (!Exit.isSuccess(result)) throw new Error("round-trip failed");
        expect(result.value.exitCode).toBe(host.exitCode);
        expect(result.value.envelope).toEqual(host.envelope);
      } finally {
        if (previousDisplay === undefined) Reflect.deleteProperty(process.env, "DISPLAY");
        else process.env.DISPLAY = previousDisplay;
      }
    });
  });

  test("a stripped allowlist rejects the round-trip with HostProxyCommandNotAllowedError", async () => {
    const { exit } = roundTrip(httpsPlan(), ["open", "--print"], { allowlist: [] });
    const result = await exit;
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toBeInstanceOf(HostProxyCommandNotAllowedError);
    }
  });

  test("round-trip publishes redacted pre/post-host-proxy-call events", async () => {
    const { events, exit } = roundTrip(httpsPlan(), ["open", "--print"]);
    await exit;
    const tags = events.map((event) => event._tag);
    expect(tags).toContain("pre-host-proxy-call");
    expect(tags).toContain("post-host-proxy-call");
  });

  test("failure envelope redacts secret-bearing route selections", async () => {
    const { exit } = roundTrip(httpsPlan(), ["open", "--route", "https://user:s3cr3tpass@missing.example"]);
    const result = await exit;
    if (!Exit.isSuccess(result)) throw new Error("round-trip failed");

    expect(result.value.exitCode).toBe(1);
    expect(result.value.envelope.ok).toBe(false);
    expect(JSON.stringify(result.value.envelope)).not.toContain("s3cr3tpass");
  });

  test("unsupported app:open arguments return a failure envelope", async () => {
    const { exit } = roundTrip(httpsPlan(), ["open", "https://example.com"]);
    const result = await exit;
    if (!Exit.isSuccess(result)) throw new Error("round-trip failed");

    expect(result.value.exitCode).toBe(2);
    expect(result.value.envelope.ok).toBe(false);
  });
});
