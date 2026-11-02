import { expect, test } from "bun:test";
import { type Server, connect, createServer } from "node:net";
import { Effect } from "effect";
import { makeAdvertisedProxyPortsCheck } from "../src/advertised-proxy-ports.ts";
import { makeRouterBindAddressCheck } from "../src/doctor-bind-address.ts";
import { buildTraefikServiceConfig, resolveTraefikPublication } from "../src/global-services/traefik.ts";
import { type AcquisitionState, readAcquisitionState } from "../src/port-acquisition-state.ts";
import { probeBind, probeForward } from "../src/port-acquisition.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import { assertAdvertisedForward } from "../src/proxy-setup.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { buildInstallScript } from "../src/socket-proxy-units.ts";
import { certificatePem, privateKeyPem } from "./current-certificate-fixture.ts";
import { makeHarness } from "./proxy-tls-harness.ts";

const isolated = process.env.LANDO_TEST_ROUTER_BIND_NETWORK === "1" ? test : test.skip;
const input = {
  providerId: "lando",
  platform: "linux" as const,
  env: {},
  userDataRoot: undefined,
  binDir: undefined,
  stateDir: undefined,
};
const serve = (hostname: string, port: number, tls = false) =>
  Bun.serve({
    hostname,
    port,
    ...(tls ? { tls: { cert: certificatePem, key: privateKeyPem } } : {}),
    fetch: () => new Response("router fixture"),
  });
const portOf = (server: ReturnType<typeof serve>): number => {
  if (server.port === undefined) throw new Error("expected TCP port");
  return server.port;
};
const hostOf = (server: ReturnType<typeof serve>): string => {
  if (server.hostname === undefined) throw new Error("expected TCP hostname");
  return server.hostname;
};

isolated("narrows live owned wildcard ports through prepare, recreation, readiness and doctor", async () => {
  const harness = makeHarness();
  let http = serve("0.0.0.0", 0);
  let https = serve("0.0.0.0", 0, true);
  const httpPort = portOf(http);
  const httpsPort = portOf(https);
  const fingerprint = { http: [httpPort], https: [httpsPort], bindAddress: "0.0.0.0" };
  const state: AcquisitionState = {
    mode: "direct",
    httpPort,
    httpsPort,
    notices: [],
    fingerprint,
    appliedFingerprint: fingerprint,
  };
  harness.files.set(acquisitionStateFile(harness.dependencies.paths), JSON.stringify(state));
  const dependencies = {
    ...harness.dependencies,
    readTraefikPublications: () =>
      Effect.succeed({
        status: "present" as const,
        bindings: [
          { port: 80, transport: "tcp" as const, hostPort: portOf(http), bindAddress: hostOf(http) },
          { port: 443, transport: "tcp" as const, hostPort: portOf(https), bindAddress: hostOf(https) },
        ],
      }),
    fingerprint,
    probeBind,
    probeForward,
    globalApp: {
      ...harness.dependencies.globalApp,
      ownedPublishPorts: (_service: unknown, ports: readonly number[]) =>
        Effect.succeed(ports.filter((port) => [httpPort, httpsPort].includes(port))),
      ensureRunning: () =>
        Effect.tryPromise(async () => {
          const desired = await Effect.runPromise(
            readAcquisitionState(harness.dependencies.fileSystem, harness.dependencies.paths),
          );
          const config = buildTraefikServiceConfig(resolveTraefikPublication(desired, "127.0.0.1"));
          const publications = config.endpoints?.filter((endpoint) => endpoint._tag === "published");
          expect(publications?.map((endpoint) => endpoint.publication.bindAddress)).toEqual([
            "127.0.0.1",
            "127.0.0.1",
          ]);
          await http.stop(true);
          await https.stop(true);
          http = serve("127.0.0.1", httpPort);
          https = serve("127.0.0.1", httpsPort, true);
          return [{ name: "traefik", state: "running" as const }];
        }),
    },
  };
  const load = () => readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  const check = makeRouterBindAddressCheck(undefined, load);
  try {
    expect((await Effect.runPromise(probeBind("127.0.0.1", httpPort))).kind).toBe("EADDRINUSE");
    expect((await Effect.runPromise(probeBind("127.0.0.1", httpsPort))).kind).toBe("EADDRINUSE");
    const service = makeTraefikRouterService(dependencies);
    const config = { defaultDomain: "lndo.site", router: { bindAddress: "127.0.0.1" } };
    if (service.prepare === undefined) throw new Error("missing prepare");
    await Effect.runPromise(Effect.scoped(service.prepare(config)));
    expect((await Effect.runPromise(load()))?.fingerprint.bindAddress).toBe("127.0.0.1");
    expect((await Effect.runPromise(load()))?.httpPort).toBe(httpPort);
    expect((await Effect.runPromise(check.run(input)))[0]).toMatchObject({
      status: "warn",
      runtimeStatus: "bind-application-unconfirmed",
      context: { lastAppliedBindAddress: "0.0.0.0" },
    });
    await Effect.runPromise(Effect.scoped(service.setup(config)));
    expect((await Effect.runPromise(check.run(input)))[0]).toMatchObject({
      status: "pass",
      runtimeStatus: "loopback",
    });
    expect((await Effect.runPromise(probeBind("127.0.0.2", httpPort))).kind).toBe("success");
    expect((await Effect.runPromise(probeBind("127.0.0.2", httpsPort))).kind).toBe("success");
  } finally {
    await http.stop(true);
    await https.stop(true);
  }
});

isolated.each(["127.0.0.2", "0:0:0:0:0:0:0:0"])(
  "real readiness and doctor reach %s publication",
  async (bindAddress) => {
    const http = serve(bindAddress, 0);
    const https = serve(bindAddress, 0, true);
    try {
      const harness = makeHarness();
      const state: AcquisitionState = {
        mode: "direct",
        httpPort: portOf(http),
        httpsPort: portOf(https),
        notices: [],
        fingerprint: { http: [portOf(http)], https: [portOf(https)], bindAddress },
      };
      harness.files.set(acquisitionStateFile(harness.dependencies.paths), JSON.stringify(state));
      const dependencies = { ...harness.dependencies, probeForward };
      expect(
        await Effect.runPromise(
          assertAdvertisedForward(dependencies, { http: state.httpPort, https: state.httpsPort }),
        ),
      ).toBe(true);
      const reports = await Effect.runPromise(
        makeAdvertisedProxyPortsCheck(undefined, {
          httpPort: state.httpPort,
          httpsPort: state.httpsPort,
          bindAddress,
        }).run(input),
      );
      expect(reports).toEqual([]);
    } finally {
      await http.stop(true);
      await https.stop(true);
    }
  },
);

isolated("rendered helper forwarding reaches loopback-only HTTP and HTTPS backends", async () => {
  const http = serve("127.0.0.1", 0);
  const https = serve("127.0.0.1", 0, true);
  const frontends: Server[] = [];
  try {
    const script = buildInstallScript({
      user: "test",
      binary: "/fixture/proxyd",
      serviceType: "simple",
      httpTarget: portOf(http),
      httpsTarget: portOf(https),
    });
    const targets = [...script.matchAll(/ExecStart=\/fixture\/proxyd (127\.0\.0\.1):(\d+)/g)];
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      const server = createServer((client) => {
        const upstream = connect({ host: target[1], port: Number(target[2]) });
        client.pipe(upstream).pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      frontends.push(server);
    }
    const ports = frontends.map((server) => server.address());
    const first = ports[0];
    const second = ports[1];
    if (first === null || second === null || typeof first !== "object" || typeof second !== "object")
      throw new Error("missing helper ports");
    expect((await Effect.runPromise(probeForward("127.0.0.1", first.port, "http"))).kind).toBe("success");
    expect((await Effect.runPromise(probeForward("127.0.0.1", second.port, "https"))).kind).toBe("success");
    expect((await Effect.runPromise(probeBind("127.0.0.2", portOf(http)))).kind).toBe("success");
    expect((await Effect.runPromise(probeBind("127.0.0.2", portOf(https)))).kind).toBe("success");
  } finally {
    for (const server of frontends) server.close();
    await http.stop(true);
    await https.stop(true);
  }
});
