import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeAdvertisedProxyPortsCheck } from "../src/advertised-proxy-ports.ts";
import { makeRouterBindAddressCheck } from "../src/doctor-bind-address.ts";
import { buildTraefikServiceConfig, resolveTraefikPublication } from "../src/global-services/traefik.ts";
import { persistPortAcquisition, readAcquisitionState } from "../src/port-acquisition-state.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { buildInstallScript } from "../src/socket-proxy-units.ts";
import { acquisition, app, makeObserveFixture, route } from "./observe-routes-fixture.ts";
import { makeHarness } from "./proxy-tls-harness.ts";

const input = {
  providerId: "lando",
  platform: "linux" as const,
  env: {},
  userDataRoot: undefined,
  binDir: undefined,
  stateDir: undefined,
};

test.each(["192.0.2.24", "0.0.0.0", "0:0:0:0:0:0:0:0"])(
  "setup and doctor consume the applied %s bind",
  async (bindAddress) => {
    const harness = makeHarness();
    const probes: string[] = [];
    const dependencies = {
      ...harness.dependencies,
      readTraefikPublications: () =>
        Effect.succeed({
          status: "present" as const,
          bindings: [
            { port: 80, transport: "tcp" as const, hostPort: 80, bindAddress },
            { port: 443, transport: "tcp" as const, hostPort: 443, bindAddress },
          ],
        }),
      probeForward: (host: string) =>
        Effect.sync(() => {
          probes.push(host);
          return { kind: "success" as const };
        }),
    };
    await Effect.runPromise(
      Effect.scoped(
        makeTraefikRouterService(dependencies).setup({ defaultDomain: "lndo.site", router: { bindAddress } }),
      ),
    );
    const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));
    const reports = await Effect.runPromise(
      makeRouterBindAddressCheck(undefined, () => Effect.succeed(state)).run(input),
    );
    expect(probes).toEqual(
      bindAddress === "192.0.2.24"
        ? [bindAddress, bindAddress]
        : bindAddress === "0.0.0.0"
          ? ["127.0.0.1", "127.0.0.1"]
          : ["::1", "::1"],
    );
    expect(state?.appliedFingerprint).toEqual(state?.fingerprint);
    expect(reports[0]?.context.bindAddress).toBe(bindAddress === "0:0:0:0:0:0:0:0" ? "::" : bindAddress);
    expect(reports[0]?.status).toBe(bindAddress === "192.0.2.24" ? "pass" : "warn");
  },
);

test.each(["prepare", "failed-start", "stale-runtime"])(
  "%s narrowing preserves the last confirmed wildcard exposure",
  async (stage) => {
    const harness = makeHarness();
    const fingerprint = { http: [8080], https: [8443], bindAddress: "0.0.0.0" };
    harness.files.set(
      acquisitionStateFile(harness.dependencies.paths),
      JSON.stringify({
        ...acquisition,
        httpPort: 8080,
        httpsPort: 8443,
        fingerprint,
        appliedFingerprint: fingerprint,
      }),
    );
    const dependencies = {
      ...harness.dependencies,
      fingerprint,
      readTraefikPublications: () =>
        Effect.succeed({
          status: "present" as const,
          bindings: [
            { port: 80, transport: "tcp" as const, hostPort: 8080, bindAddress: "0.0.0.0" },
            { port: 443, transport: "tcp" as const, hostPort: 8443, bindAddress: "0.0.0.0" },
          ],
        }),
      globalApp: {
        ...harness.dependencies.globalApp,
        ensureRunning: () =>
          stage === "stale-runtime" ? Effect.succeed([]) : Effect.fail("interrupted recreation"),
      },
    };
    const service = makeTraefikRouterService(dependencies);
    const config = { defaultDomain: "lndo.site", router: { bindAddress: "127.0.0.1" } };
    if (stage === "prepare") {
      if (service.prepare === undefined) throw new Error("missing prepare");
      await Effect.runPromise(Effect.scoped(service.prepare(config)));
    } else {
      const result = await Effect.runPromise(Effect.scoped(service.setup(config)).pipe(Effect.result));
      expect(result._tag).toBe(stage === "stale-runtime" ? "Success" : "Failure");
    }
    await Effect.runPromise(service.revalidateStartup);
    const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));
    const reports = await Effect.runPromise(
      makeRouterBindAddressCheck(undefined, () => Effect.succeed(state)).run(input),
    );
    expect(state?.fingerprint.bindAddress).toBe("127.0.0.1");
    expect(reports[0]).toMatchObject({
      status: "warn",
      runtimeStatus: "bind-application-unconfirmed",
      context: { bindAddress: "127.0.0.1", lastAppliedBindAddress: "0.0.0.0" },
    });
  },
);

test("failed readiness does not confirm a narrowed bind", async () => {
  const harness = makeHarness();
  const fingerprint = { http: [8080], https: [8443], bindAddress: "0.0.0.0" };
  harness.files.set(
    acquisitionStateFile(harness.dependencies.paths),
    JSON.stringify({ ...acquisition, fingerprint, appliedFingerprint: fingerprint }),
  );
  const dependencies = {
    ...harness.dependencies,
    fingerprint,
    probeForward: () => Effect.succeed({ kind: "failure" as const }),
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          makeTraefikRouterService(dependencies).setup({
            defaultDomain: "lndo.site",
            router: { bindAddress: "127.0.0.1" },
          }),
        ),
      );
      yield* TestClock.adjust(10_000);
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));
  expect(state?.appliedFingerprint?.bindAddress).toBe("0.0.0.0");
});

test("status preserves route hostnames and acquired ports for a specific bind", async () => {
  const harness = makeHarness();
  await Effect.runPromise(
    Effect.scoped(
      harness.service.setup({
        defaultDomain: "example.test",
        router: { bindAddress: "192.0.2.24", httpPort: 18080, httpsPort: 18443 },
      }),
    ),
  );
  await Effect.runPromise(Effect.scoped(harness.service.applyRoutes([route], app)));
  const status = await Effect.runPromise(harness.service.status);
  expect(status.authorities).toEqual([
    { hostname: route.hostname, scheme: "http", port: 18080 },
    { hostname: route.hostname, scheme: "https", port: 18443 },
  ]);
});

test("a normal start confirms the bind after live route acceptance", async () => {
  const harness = makeHarness();
  const dependencies = {
    ...harness.dependencies,
    readTraefikPublications: () =>
      Effect.succeed({
        status: "present" as const,
        bindings: [
          { port: 80, transport: "tcp" as const, hostPort: 80, bindAddress: "127.0.0.1" },
          { port: 443, transport: "tcp" as const, hostPort: 443, bindAddress: "127.0.0.1" },
        ],
      }),
  };
  const service = makeTraefikRouterService(dependencies);
  if (service.prepare === undefined) throw new Error("missing prepare");
  await Effect.runPromise(
    Effect.scoped(service.prepare({ defaultDomain: "example.test", router: { bindAddress: "127.0.0.1" } })),
  );
  const before = await Effect.runPromise(
    readAcquisitionState(harness.dependencies.fileSystem, harness.dependencies.paths),
  );
  expect(before?.appliedFingerprint).toBeUndefined();
  await Effect.runPromise(Effect.scoped(service.applyRoutes([route], app)));
  const after = await Effect.runPromise(
    readAcquisitionState(harness.dependencies.fileSystem, harness.dependencies.paths),
  );
  expect(after?.appliedFingerprint).toEqual(after?.fingerprint);
});

test.each(["192.0.2.24", "0.0.0.0"])(
  "does not reuse installed loopback helper for %s",
  async (bindAddress) => {
    const harness = makeHarness();
    harness.files.set(
      acquisitionStateFile(harness.dependencies.paths),
      JSON.stringify({
        ...acquisition,
        mode: "socket-helper",
        httpPort: 80,
        httpsPort: 443,
        bindHttpPort: 38080,
        bindHttpsPort: 38443,
        helperInstalled: true,
        socketsActive: true,
      }),
    );
    const dependencies = {
      ...harness.dependencies,
      router: { bindAddress },
      probeBind: (_host: string, port: number) =>
        Effect.succeed(
          port < 1024 ? { kind: "EACCES" as const, code: "EACCES" as const } : { kind: "success" as const },
        ),
    };
    const decision = await Effect.runPromise(persistPortAcquisition(dependencies));
    expect(decision.mode).toBe("occupied-hop");
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
    expect(decision.fingerprint.bindAddress).toBe(bindAddress);
  },
);

test("helper unit forwarding retains a private backend", () => {
  const config = buildTraefikServiceConfig(
    resolveTraefikPublication(
      {
        ...acquisition,
        mode: "socket-helper",
        bindHttpPort: 38080,
        bindHttpsPort: 38443,
        fingerprint: { ...acquisition.fingerprint, bindAddress: "192.0.2.24" },
      },
      "0.0.0.0",
    ),
  );
  expect(
    config.endpoints
      ?.filter((endpoint) => endpoint._tag === "published")
      .map((endpoint) => endpoint.publication),
  ).toEqual([
    { bindAddress: "127.0.0.1", hostPort: 38080 },
    { bindAddress: "127.0.0.1", hostPort: 38443 },
  ]);
  const script = buildInstallScript({
    user: "test",
    binary: "/usr/lib/systemd/systemd-socket-proxyd",
    serviceType: "notify",
    httpTarget: 38080,
    httpsTarget: 38443,
  });
  expect(script).toContain("ListenStream=127.0.0.1:80");
  expect(script).toContain("ListenStream=127.0.0.1:443");
  expect(script).toContain("ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:38080");
  expect(script).toContain("ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:38443");
});

test.each([
  ["192.0.2.24", "192.0.2.24"],
  ["0:0:0:0:0:0:0:0", "::1"],
])("route observation probes %s through %s", async (bindAddress, host) => {
  const fixture = makeObserveFixture();
  fixture.files.set(
    acquisitionStateFile(fixture.paths),
    JSON.stringify({ ...acquisition, fingerprint: { ...acquisition.fingerprint, bindAddress } }),
  );
  const evidence = await Effect.runPromise(fixture.service.observeRoutes(app, [route]));
  expect(evidence.observation.status).toBe("present");
  expect(fixture.probes.map(([address]) => address)).toEqual([host, host]);
});

test("advertised-port doctor probes the configured interface", async () => {
  const calls: string[] = [];
  const reports = await Effect.runPromise(
    makeAdvertisedProxyPortsCheck(
      {
        readPort: async (port, _role, host) => {
          calls.push(host);
          return { port, listening: true, httpOk: false };
        },
      },
      { httpPort: 8080, httpsPort: 8443, bindAddress: "192.0.2.24" },
    ).run(input),
  );
  expect(calls).toEqual(["192.0.2.24", "192.0.2.24"]);
  expect(reports[0]?.context.host).toBe("192.0.2.24");
});
