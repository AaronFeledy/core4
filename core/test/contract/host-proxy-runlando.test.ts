import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { HostProxyCommandNotAllowedError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import {
  AbsolutePath,
  type AppPlan,
  type CommandResultEnvelope,
  type RoutePlan,
  ServiceName,
} from "@lando/sdk/schema";
import { EventService, ShellRunner } from "@lando/sdk/services";

import { type OpenAppOptions, OpenAppResultSchema, openForPlan } from "../../src/cli/commands/open.ts";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../../src/cli/oclif/generated/host-proxy-allowlist.ts";
import { buildCommandResultEnvelope } from "../../src/cli/result-encode.ts";
import {
  RedactionService,
  type RedactionServiceShape,
  createStandaloneRedactor,
} from "../../src/redaction/service.ts";
import {
  type HostProxyRunLandoExecutor,
  dispatchRunLando,
  runOpenForHostProxy,
} from "../../src/subsystems/host-proxy/dispatch.ts";
import { buildRunLandoRequest } from "../../src/subsystems/host-proxy/shim.ts";

const route = (over: Pick<RoutePlan, "hostname" | "scheme"> & { readonly service: string }): RoutePlan => ({
  ...over,
  service: ServiceName.make(over.service),
  backend: { service: ServiceName.make(over.service), protocol: "http", port: 80 },
});

const makePlan = (routes: RoutePlan[], serviceNames: string[]): AppPlan => {
  const services: Record<string, unknown> = {};
  for (const name of serviceNames) services[name] = { name, routes: [], endpoints: [] };
  return {
    id: "myapp",
    name: "myapp",
    root: "/srv/apps/myapp",
    services,
    routes,
  } as unknown as AppPlan;
};

const appRef = { kind: "user" as const, id: "myapp", root: AbsolutePath.make("/srv/apps/myapp") };
const mount = { containerRoot: "/app", hostRoot: "/srv/apps/myapp" };

const shellLayer = () =>
  Layer.succeed(ShellRunner, {
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    run: () => Effect.die("nu"),
    runScript: () => Effect.die("nu"),
    interactive: () => Effect.die("nu"),
  } as never);

const silentEventLayer = () =>
  Layer.succeed(EventService, {
    publish: () => Effect.void,
    subscribe: () => Effect.die("nu"),
    subscribeQueue: Effect.die("nu"),
    waitFor: () => Effect.die("nu"),
    waitForAny: () => Effect.die("nu"),
    query: () => Effect.die("nu"),
  } as never);

const recordingEventLayer = () => {
  const events: LandoEvent[] = [];
  const layer = Layer.succeed(EventService, {
    publish: (event: LandoEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Effect.die("nu"),
    subscribeQueue: Effect.die("nu"),
    waitFor: () => Effect.die("nu"),
    waitForAny: () => Effect.die("nu"),
    query: () => Effect.die("nu"),
  } as never);
  return { events, layer };
};

const standaloneRedactionService: RedactionServiceShape = {
  forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
};

const redactionLayer = () =>
  Layer.succeed(RedactionService, {
    ...standaloneRedactionService,
  });

const commandServices = (eventLayer: Layer.Layer<EventService>) =>
  Layer.mergeAll(shellLayer(), eventLayer, redactionLayer());

const hostSideEnvelope = (
  plan: AppPlan,
  options: OpenAppOptions,
): Promise<{ envelope: CommandResultEnvelope; exitCode: number }> => {
  const redactor = createStandaloneRedactor("secrets", { sourceEnv: process.env });
  const program = Effect.gen(function* () {
    const outcome = yield* Effect.exit(openForPlan(plan, options));
    const encoded = Exit.isSuccess(outcome)
      ? { outcome: { _tag: "success" as const, value: outcome.value }, exitCode: 0 }
      : {
          outcome: {
            _tag: "failure" as const,
            error: Option.getOrElse(Cause.failureOption(outcome.cause), () => ({
              _tag: "HostProxyDispatchError",
              message: Cause.pretty(outcome.cause),
            })),
          },
          exitCode: 1,
        };
    const envelope = yield* buildCommandResultEnvelope({
      command: "app:open",
      resultSchema: OpenAppResultSchema,
      outcome: encoded.outcome,
      redactor,
    });
    return { envelope, exitCode: encoded.exitCode };
  });
  return Effect.runPromise(program.pipe(Effect.provide(commandServices(silentEventLayer()))));
};

const roundTrip = (
  plan: AppPlan,
  argv: ReadonlyArray<string>,
  extras: { readonly allowlist?: ReadonlyArray<string>; readonly cwd?: string; readonly tty?: boolean } = {},
) => {
  const { events, layer } = recordingEventLayer();
  const executor: HostProxyRunLandoExecutor = (input) =>
    runOpenForHostProxy(plan, input).pipe(Effect.provide(commandServices(silentEventLayer())));
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
      const hostResult = host.envelope.result as { launch?: string } | undefined;
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
        const hostResult = host.envelope.result as { launch?: string } | undefined;
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
      const error = result.cause._tag === "Fail" ? result.cause.error : undefined;
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
