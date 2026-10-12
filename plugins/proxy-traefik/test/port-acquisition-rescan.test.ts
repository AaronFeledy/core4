import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { readAcquisitionState } from "../src/port-acquisition-state.ts";
import type { AcquisitionDecision } from "../src/port-acquisition.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths } from "../src/proxy-types.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";

const router = {
  httpPort: 46080,
  httpsPort: 46443,
  httpFallbacks: [46081, 46082],
  httpsFallbacks: [46444, 46445],
} as const;
const config = { defaultDomain: "lndo.site", router };

const fixture = (platform: ProxyPaths["platform"] = "linux") => {
  const paths = { platform, globalAppRoot: "/lando/global" };
  const files = new Map<string, string>();
  const own = new Set<number>();
  const foreign = new Set<number>();
  const ownershipRequests: number[][] = [];
  const applied: AcquisitionDecision[] = [];
  let ownershipFails = false;
  const fileSystem: ProxyFileSystem = {
    mkdir: () => Effect.void,
    exists: (path) => Effect.succeed(files.has(path)),
    readDir: () => Effect.succeed([]),
    readText: (path) => {
      const content = files.get(path);
      return content === undefined ? Effect.fail(new Error("missing fixture file")) : Effect.succeed(content);
    },
    writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
    writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
    remove: (path) => Effect.sync(() => void files.delete(path)),
  };
  const service = makeTraefikRouterService({
    paths,
    fileSystem,
    certificateAuthority: makeTestCertificateAuthority(),
    probeBind: (_host, port) =>
      Effect.succeed(
        foreign.has(port) || (platform !== "win32" && own.has(port))
          ? { kind: "EADDRINUSE" as const, code: "EADDRINUSE" }
          : { kind: "success" as const },
      ),
    probeForward: () => Effect.succeed({ kind: "success" as const }),
    globalApp: {
      occupiedPublishPorts: (ports) =>
        Effect.succeed(ports.filter((port) => own.has(port) || foreign.has(port))),
      ownedPublishPorts: (serviceId, ports) => {
        expect(serviceId).toBe(ServiceName.make("traefik"));
        ownershipRequests.push([...ports]);
        return ownershipFails
          ? Effect.fail(new Error("provider unavailable"))
          : Effect.succeed(ports.filter((port) => own.has(port)));
      },
      ensureRunning: Effect.fnUntraced(function* () {
        const state = yield* readAcquisitionState(fileSystem, paths);
        if (state !== undefined) applied.push(state);
        return [{ name: "traefik", state: "running", endpoints: [] }];
      }),
    },
  });
  return {
    service,
    own,
    foreign,
    applied,
    ownershipRequests,
    failOwnership: () => {
      ownershipFails = true;
    },
    seed: (mode: AcquisitionDecision["mode"], httpPort: number, httpsPort: number) => {
      files.set(
        acquisitionStateFile(paths),
        JSON.stringify({
          mode,
          httpPort,
          httpsPort,
          notices: [],
          fingerprint: {
            http: [router.httpPort, ...router.httpFallbacks],
            https: [router.httpsPort, ...router.httpsFallbacks],
            bindAddress: "127.0.0.1",
          },
        }),
      );
      own.add(httpPort);
      own.add(httpsPort);
    },
    state: () => Effect.runPromise(readAcquisitionState(fileSystem, paths)),
  };
};

describe("router ownership-aware rescans", () => {
  for (const platform of ["linux", "win32"] as const) {
    test(`setup keeps owned HTTPS when HTTP preference changes on ${platform}`, async () => {
      // Given
      const f = fixture(platform);
      f.seed("direct", 46080, 46443);
      // When
      await Effect.runPromise(
        Effect.scoped(
          f.service.setup(
            {
              ...config,
              router: { ...router, httpPort: 46090 },
            },
            { reacquirePorts: true },
          ),
        ),
      );
      // Then
      expect(await f.state()).toMatchObject({
        mode: "direct",
        httpPort: 46090,
        httpsPort: 46443,
        notices: [],
      });
      expect(f.applied).toMatchObject([{ httpPort: 46090, httpsPort: 46443 }]);
    });

    test(`setup keeps the same direct pair when its own router holds both ports on ${platform}`, async () => {
      // Given
      const f = fixture(platform);
      f.seed("direct", 46080, 46443);
      // When
      await Effect.runPromise(Effect.scoped(f.service.setup(config, { reacquirePorts: true })));
      // Then
      expect(await f.state()).toMatchObject({
        mode: "direct",
        httpPort: 46080,
        httpsPort: 46443,
        notices: [],
      });
    });
  }

  test("setup reclaims preferred ports when an owned occupied-hop pair is still running", async () => {
    // Given
    const f = fixture("win32");
    f.seed("occupied-hop", 46081, 46444);
    // When
    await Effect.runPromise(Effect.scoped(f.service.setup(config, { reacquirePorts: true })));
    // Then
    expect(await f.state()).toMatchObject({ mode: "direct", httpPort: 46080, httpsPort: 46443, notices: [] });
  });

  test("setup reclaims an earlier fallback when the preferred port stays occupied", async () => {
    // Given
    const f = fixture("win32");
    f.seed("occupied-hop", 46082, 46445);
    f.foreign.add(46080);
    // When
    await Effect.runPromise(Effect.scoped(f.service.setup(config, { reacquirePorts: true })));
    // Then
    expect(await f.state()).toMatchObject({ mode: "occupied-hop", httpPort: 46081, httpsPort: 46443 });
  });

  test("a foreign preferred-port holder still produces occupied-hop notices", async () => {
    // Given
    const f = fixture();
    f.foreign.add(46080);
    // When
    await Effect.runPromise(Effect.scoped(f.service.setup(config, { reacquirePorts: true })));
    // Then
    const state = await f.state();
    expect(state).toMatchObject({ mode: "occupied-hop", httpPort: 46081, httpsPort: 46443 });
    expect(state?.notices.length).toBeGreaterThan(0);
  });

  test("prepare retains an owned occupied-hop pair even after preferred ports become free", async () => {
    // Given
    const f = fixture("win32");
    f.seed("occupied-hop", 46081, 46444);
    if (f.service.prepare === undefined) throw new Error("prepare is unavailable");
    // When
    await Effect.runPromise(f.service.prepare(config));
    // Then
    expect(await f.state()).toMatchObject({ mode: "occupied-hop", httpPort: 46081, httpsPort: 46444 });
    expect(f.applied).toEqual([]);
  });

  test("prepare rescans changed preferences without discarding the owned HTTPS port", async () => {
    // Given
    const f = fixture();
    f.seed("direct", 46080, 46443);
    if (f.service.prepare === undefined) throw new Error("prepare is unavailable");
    // When
    await Effect.runPromise(f.service.prepare({ ...config, router: { ...router, httpPort: 46090 } }));
    // Then
    expect(await f.state()).toMatchObject({ mode: "direct", httpPort: 46090, httpsPort: 46443 });
  });

  test("app-start router setup keeps an owned occupied-hop pair when preferences are unchanged", async () => {
    // Given
    const f = fixture("win32");
    f.seed("occupied-hop", 46081, 46444);
    // When
    await Effect.runPromise(Effect.scoped(f.service.setup(config)));
    // Then
    expect(await f.state()).toMatchObject({ mode: "occupied-hop", httpPort: 46081, httpsPort: 46444 });
    expect(f.applied).toMatchObject([{ httpPort: 46081, httpsPort: 46444 }]);
  });

  for (const platform of ["linux", "win32"] as const) {
    test(`ownership query failure keeps conservative fallback classification on ${platform}`, async () => {
      // Given
      const f = fixture(platform);
      f.seed("direct", 46080, 46443);
      f.failOwnership();
      // When
      await Effect.runPromise(Effect.scoped(f.service.setup(config, { reacquirePorts: true })));
      // Then
      expect(await f.state()).toMatchObject({ mode: "occupied-hop", httpPort: 46081, httpsPort: 46444 });
    });
  }

  test("first setup on free ports never queries router ownership", async () => {
    // Given
    const f = fixture();
    f.failOwnership();
    // When
    await Effect.runPromise(Effect.scoped(f.service.setup(config, { reacquirePorts: true })));
    // Then
    expect(await f.state()).toMatchObject({ mode: "direct", httpPort: 46080, httpsPort: 46443 });
    expect(f.ownershipRequests).toEqual([]);
  });
});
