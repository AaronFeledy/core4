import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";

import { DEFAULT_ROUTER_HTTPS_PORTS, DEFAULT_ROUTER_HTTP_PORTS, ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { readAcquisitionState } from "../src/port-acquisition-state.ts";
import type { AcquisitionFingerprint } from "../src/port-acquisition.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";

const paths = { platform: "win32" as const, globalAppRoot: "C:\\lando\\global" };

const resolvedDefaultRouter = {
  bindAddress: "127.0.0.1",
  httpPort: DEFAULT_ROUTER_HTTP_PORTS[0],
  httpsPort: DEFAULT_ROUTER_HTTPS_PORTS[0],
  httpFallbacks: [...DEFAULT_ROUTER_HTTP_PORTS.slice(1)],
  httpsFallbacks: [...DEFAULT_ROUTER_HTTPS_PORTS.slice(1)],
};

const makeFixture = (platform: "win32" | "linux" = "win32", fingerprint?: AcquisitionFingerprint) => {
  const fixturePaths = { ...paths, platform };
  const files = new Map<string, string>();
  const running = new Set<number>();
  const guestOccupied = new Set([80, 443]);
  const hostOccupied = new Set<number>();
  const hostProbes: number[] = [];
  const guestRequested: number[] = [];
  let starts = 0;
  let guestProbes = 0;
  let ready = true;
  let readinessCalls = 0;
  let failReadiness = false;
  const sequence: string[] = [];
  const fileSystem = {
    mkdir: () => Effect.void,
    exists: (path: string) => Effect.succeed(files.has(path)),
    readDir: () => Effect.succeed([]),
    readText: (path: string) =>
      files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
    writeAtomic: (path: string, content: string | Uint8Array) =>
      Effect.sync(() => {
        files.set(path, String(content));
      }),
    writeSecretAtomic: (path: string, content: string | Uint8Array) =>
      Effect.sync(() => {
        files.set(path, String(content));
      }),
    remove: (path: string) =>
      Effect.sync(() => {
        files.delete(path);
      }),
  };
  const service = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem,
    paths: fixturePaths,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    globalApp: {
      ensureProviderReady: Effect.suspend(() => {
        sequence.push("ready");
        readinessCalls += 1;
        if (failReadiness) return Effect.fail(new Error("machine start failed"));
        ready = true;
        return Effect.void;
      }),
      occupiedPublishPorts: (ports) =>
        Effect.sync(() => {
          sequence.push("guest-probe");
          guestProbes += 1;
          guestRequested.push(...ports);
          return ready ? ports.filter((port) => guestOccupied.has(port)) : [];
        }),
      ownedPublishPorts: (serviceId, ports) =>
        Effect.succeed(
          serviceId === ServiceName.make("traefik") ? ports.filter((port) => running.has(port)) : [],
        ),
      ensureRunning: () =>
        Effect.gen(function* () {
          starts += 1;
          const state = yield* readAcquisitionState(fileSystem, fixturePaths);
          if (state !== undefined) {
            running.add(state.httpPort);
            running.add(state.httpsPort);
            guestOccupied.add(state.httpPort);
            guestOccupied.add(state.httpsPort);
          }
          return [{ name: "traefik", state: "running", endpoints: [] }];
        }),
    },
    probeBind: (_host, port) =>
      Effect.sync(() => {
        hostProbes.push(port);
        return hostOccupied.has(port)
          ? ({ kind: "EADDRINUSE", code: "EADDRINUSE" } as const)
          : ({ kind: "success" } as const);
      }),
    probeForward: () => Effect.succeed({ kind: "success" as const }),
  });
  return {
    service,
    files,
    running,
    guestOccupied,
    hostOccupied,
    hostProbes,
    guestRequested,
    sequence,
    setStopped: () => {
      ready = false;
    },
    setReadinessFailure: () => {
      failReadiness = true;
    },
    get readinessCalls() {
      return readinessCalls;
    },
    get starts() {
      return starts;
    },
    get guestProbes() {
      return guestProbes;
    },
  };
};

describe("Windows guest publication occupancy", () => {
  test("prepare chooses fallback before global start and setup reuses the owned pair", async () => {
    const fixture = makeFixture();
    const config = { defaultDomain: "lndo.site" };
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(fixture.service.prepare(config));
    const prepared = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(prepared).toMatchObject({ httpPort: 8080, httpsPort: 8443 });
    expect(fixture.starts).toBe(0);
    // The app start operation starts global Traefik between prepare and route setup.
    fixture.running.add(prepared.httpPort);
    fixture.running.add(prepared.httpsPort);
    fixture.guestOccupied.add(prepared.httpPort);
    fixture.guestOccupied.add(prepared.httpsPort);

    await Effect.runPromise(Effect.scoped(fixture.service.setup(config)));
    const applied = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(applied).toMatchObject(prepared);
    expect(fixture.starts).toBe(1);

    await Effect.runPromise(Effect.scoped(fixture.service.setup(config)));
    const repeated = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(repeated).toMatchObject(prepared);
    expect(fixture.starts).toBe(2);
  });

  test("starts a stopped Windows provider before probing and avoids stale guest claims", async () => {
    const fixture = makeFixture();
    const config = { defaultDomain: "lndo.site" };
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(fixture.service.prepare(config));
    const before = fixture.files.get(acquisitionStateFile(paths));
    expect(before).toBeDefined();
    const pair = JSON.parse(before ?? "null") as { httpPort: number; httpsPort: number };
    fixture.running.add(pair.httpPort);
    fixture.running.add(pair.httpsPort);
    fixture.guestOccupied.add(pair.httpPort);
    fixture.guestOccupied.add(pair.httpsPort);

    fixture.running.clear();
    fixture.sequence.length = 0;
    fixture.setStopped();
    await Effect.runPromise(fixture.service.prepare(config));
    expect(fixture.sequence[0]).toBe("ready");
    expect(fixture.sequence).toContain("guest-probe");
    const selected = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(selected.httpPort).not.toBe(80);
    expect(selected.httpsPort).not.toBe(443);
    expect(selected.httpPort).not.toBe(pair.httpPort);
    expect(selected.httpsPort).not.toBe(pair.httpsPort);

    await Effect.runPromise(Effect.scoped(fixture.service.setup(config)));
    expect(fixture.files.get(acquisitionStateFile(paths))).toContain(`"httpPort":${selected.httpPort}`);
    expect(fixture.readinessCalls).toBe(3);
  });

  test("reuses a persisted pair when restarted guest ports are truly free", async () => {
    const fixture = makeFixture();
    const config = { defaultDomain: "lndo.site" };
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(fixture.service.prepare(config));
    const before = fixture.files.get(acquisitionStateFile(paths));
    const pair = JSON.parse(before ?? "null") as { httpPort: number; httpsPort: number };
    fixture.running.clear();
    fixture.guestOccupied.delete(pair.httpPort);
    fixture.guestOccupied.delete(pair.httpsPort);
    fixture.setStopped();

    await Effect.runPromise(fixture.service.prepare(config));
    expect(fixture.files.get(acquisitionStateFile(paths))).toBe(before);
  });
  test("readiness failure stops port planning before probing or changing persisted ports", async () => {
    const fixture = makeFixture();
    const config = { defaultDomain: "lndo.site" };
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(fixture.service.prepare(config));
    const before = fixture.files.get(acquisitionStateFile(paths));
    const probesBefore = fixture.guestProbes;
    fixture.setStopped();
    fixture.setReadinessFailure();

    const exit = await Effect.runPromiseExit(fixture.service.prepare(config));
    expect(exit._tag).toBe("Failure");
    expect(fixture.guestProbes).toBe(probesBefore);
    expect(fixture.files.get(acquisitionStateFile(paths))).toBe(before);
  });
  test("moves past stale guest claims to clean fallback ports", async () => {
    const fixture = makeFixture();
    for (const port of [8080, 8000, 8888, 8008, 8443, 4443, 4433, 4444, 444]) {
      fixture.guestOccupied.add(port);
    }
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(fixture.service.prepare({ defaultDomain: "lndo.site" }));
    const prepared = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(prepared).toMatchObject({ httpPort: 18080, httpsPort: 18443 });
  });
  test("extends an old default fingerprint past stale claims with host and guest probes", async () => {
    const fixture = makeFixture("win32", {
      http: [...DEFAULT_ROUTER_HTTP_PORTS],
      https: [...DEFAULT_ROUTER_HTTPS_PORTS],
      bindAddress: "127.0.0.1",
    });
    for (const port of [...DEFAULT_ROUTER_HTTP_PORTS, ...DEFAULT_ROUTER_HTTPS_PORTS]) {
      fixture.guestOccupied.add(port);
    }
    fixture.hostOccupied.add(48081);
    fixture.hostOccupied.add(48444);
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

    await Effect.runPromise(fixture.service.prepare({ defaultDomain: "lndo.site" }));
    const prepared = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
      fingerprint: { http: number[]; https: number[] };
    };
    expect(prepared).toMatchObject({ httpPort: 58081, httpsPort: 58444 });
    expect(prepared.fingerprint.http).toContain(48081);
    expect(prepared.fingerprint.https).toContain(48444);
    for (const port of [48081, 58081, 48082, 58082, 48444, 58444, 48445, 58445]) {
      expect(fixture.hostProbes).toContain(port);
      expect(fixture.guestRequested).toContain(port);
    }
    expect(fixture.guestProbes).toBe(1);
  });

  test("fails closed when every extended Windows candidate is occupied in the guest", async () => {
    const fixture = makeFixture();
    for (const port of [
      ...DEFAULT_ROUTER_HTTP_PORTS,
      ...DEFAULT_ROUTER_HTTPS_PORTS,
      48081,
      58081,
      48082,
      58082,
      48444,
      58444,
      48445,
      58445,
    ]) {
      fixture.guestOccupied.add(port);
    }
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

    const exit = await Effect.runPromiseExit(fixture.service.prepare({ defaultDomain: "lndo.site" }));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause) as {
        _tag?: string;
        httpTried?: number[];
        httpsTried?: number[];
      };
      expect(failure._tag).toBe("RouterPortsExhausted");
      expect(failure.httpTried).toContain(58082);
      expect(failure.httpsTried).toContain(58445);
    }
    expect(fixture.files.has(acquisitionStateFile(paths))).toBe(false);
  });

  test("keeps explicit SDK-default fallbacks finite even with an old default fingerprint", async () => {
    const fixture = makeFixture("win32", {
      http: [...DEFAULT_ROUTER_HTTP_PORTS],
      https: [...DEFAULT_ROUTER_HTTPS_PORTS],
      bindAddress: "127.0.0.1",
    });
    for (const port of [...DEFAULT_ROUTER_HTTP_PORTS, ...DEFAULT_ROUTER_HTTPS_PORTS]) {
      fixture.guestOccupied.add(port);
    }
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

    const exit = await Effect.runPromiseExit(
      fixture.service.prepare({ defaultDomain: "lndo.site", router: resolvedDefaultRouter }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause) as {
        _tag?: string;
        httpTried?: number[];
        httpsTried?: number[];
      };
      expect(failure._tag).toBe("RouterPortsExhausted");
      expect(failure.httpTried).toEqual([...DEFAULT_ROUTER_HTTP_PORTS]);
      expect(failure.httpsTried).toEqual([...DEFAULT_ROUTER_HTTPS_PORTS]);
    }
    expect(fixture.hostProbes).not.toContain(48081);
    expect(fixture.hostProbes).not.toContain(48444);
  });

  test("keeps a configured HTTP preferred port finite while HTTPS defaults can extend", async () => {
    const fixture = makeFixture();
    for (const port of DEFAULT_ROUTER_HTTP_PORTS) fixture.guestOccupied.add(port);
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

    const exit = await Effect.runPromiseExit(
      fixture.service.prepare({ defaultDomain: "lndo.site", router: { httpPort: 80 } }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause) as { _tag?: string; httpTried?: number[] };
      expect(failure._tag).toBe("RouterPortsExhausted");
      expect(failure.httpTried).toEqual([...DEFAULT_ROUTER_HTTP_PORTS]);
    }
    expect(fixture.hostProbes).not.toContain(48081);
    expect(fixture.guestRequested).toContain(48444);
  });

  test("keeps explicit Windows fallbacks finite when an old default fingerprint is supplied", async () => {
    const fixture = makeFixture("win32", {
      http: [...DEFAULT_ROUTER_HTTP_PORTS],
      https: [...DEFAULT_ROUTER_HTTPS_PORTS],
      bindAddress: "127.0.0.1",
    });
    for (const port of [80, 8080, 443, 8443]) fixture.guestOccupied.add(port);
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

    const exit = await Effect.runPromiseExit(
      fixture.service.prepare({
        defaultDomain: "lndo.site",
        router: { httpPort: 80, httpsPort: 443, httpFallbacks: [8080], httpsFallbacks: [8443] },
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause) as {
        _tag?: string;
        httpTried?: number[];
        httpsTried?: number[];
      };
      expect(failure._tag).toBe("RouterPortsExhausted");
      expect(failure.httpTried).toEqual([80, 8080]);
      expect(failure.httpsTried).toEqual([443, 8443]);
    }
    expect(fixture.hostProbes).not.toContain(48081);
    expect(fixture.hostProbes).not.toContain(48444);
  });

  test("honors a nondefault merged Windows router over a prior fingerprint", async () => {
    const fixture = makeFixture("win32", {
      http: [9090],
      https: [9443],
      bindAddress: "127.0.0.1",
    });
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(
      fixture.service.prepare({
        defaultDomain: "lndo.site",
        router: { httpPort: 9990, httpsPort: 9943, httpFallbacks: [9991], httpsFallbacks: [9944] },
      }),
    );
    const prepared = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
      fingerprint: { http: number[]; https: number[] };
    };
    expect(prepared).toMatchObject({ httpPort: 9990, httpsPort: 9943 });
    expect(prepared.fingerprint.http).toEqual([9990, 9991]);
    expect(prepared.fingerprint.https).toEqual([9943, 9944]);
  });

  test("keeps the owned global port pair across two app starts with expanded fallback lists", async () => {
    const fixture = makeFixture();
    const defaultConfig = { defaultDomain: "lndo.site" };
    const appConfig = {
      defaultDomain: "lndo.site",
      router: {
        httpPort: 80,
        httpsPort: 443,
        httpFallbacks: [8080, 8000, 8888, 8008, 38080],
        httpsFallbacks: [8443, 4443, 4433, 4444, 444, 38443],
      },
    };
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

    await Effect.runPromise(Effect.scoped(fixture.service.setup(defaultConfig)));
    const initial = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(initial).toBeDefined();

    for (const _app of ["first", "second"]) {
      await Effect.runPromise(fixture.service.prepare(appConfig));
      await Effect.runPromise(Effect.scoped(fixture.service.setup(appConfig)));
      const current = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
        httpPort: number;
        httpsPort: number;
      };
      expect(current.httpPort).toBe(initial.httpPort);
      expect(current.httpsPort).toBe(initial.httpsPort);
    }
  });

  test("does not claim another global service's occupied publication", async () => {
    const fixture = makeFixture();
    const config = { defaultDomain: "lndo.site" };
    if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
    await Effect.runPromise(fixture.service.prepare(config));
    const first = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    fixture.guestOccupied.add(first.httpPort);
    fixture.guestOccupied.add(first.httpsPort);
    await Effect.runPromise(fixture.service.prepare(config));
    const next = JSON.parse(fixture.files.get(acquisitionStateFile(paths)) ?? "null") as {
      httpPort: number;
      httpsPort: number;
    };
    expect(next.httpPort).not.toBe(first.httpPort);
    expect(next.httpsPort).not.toBe(first.httpsPort);
  });
});

test("Linux keeps fingerprint precedence when router config differs", async () => {
  const fixture = makeFixture("linux", {
    http: [9090],
    https: [9443],
    bindAddress: "127.0.0.1",
  });
  if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
  await Effect.runPromise(
    fixture.service.prepare({
      defaultDomain: "lndo.site",
      router: { httpPort: 9990, httpsPort: 9943, httpFallbacks: [9991], httpsFallbacks: [9944] },
    }),
  );
  const prepared = JSON.parse(
    fixture.files.get(acquisitionStateFile({ ...paths, platform: "linux" })) ?? "null",
  ) as {
    httpPort: number;
    httpsPort: number;
    fingerprint: { http: number[]; https: number[] };
  };
  expect(prepared).toMatchObject({ httpPort: 9090, httpsPort: 9443 });
  expect(prepared.fingerprint.http).toEqual([9090]);
  expect(prepared.fingerprint.https).toEqual([9443]);
});

test("Linux keeps the original finite default list when its host ports are occupied", async () => {
  const fixture = makeFixture("linux");
  for (const port of [...DEFAULT_ROUTER_HTTP_PORTS, ...DEFAULT_ROUTER_HTTPS_PORTS]) {
    fixture.hostOccupied.add(port);
  }
  if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");

  const exit = await Effect.runPromiseExit(fixture.service.prepare({ defaultDomain: "lndo.site" }));
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const failure = Cause.squash(exit.cause) as {
      _tag?: string;
      httpTried?: number[];
      httpsTried?: number[];
    };
    expect(failure._tag).toBe("RouterPortsExhausted");
    expect(failure.httpTried).toEqual([...DEFAULT_ROUTER_HTTP_PORTS]);
    expect(failure.httpsTried).toEqual([...DEFAULT_ROUTER_HTTPS_PORTS]);
  }
  expect(fixture.hostProbes).not.toContain(48081);
  expect(fixture.hostProbes).not.toContain(48444);
  expect(fixture.guestProbes).toBe(0);
});

test("Unix host bind planning never probes provider guest ports", async () => {
  const fixture = makeFixture("linux");
  if (fixture.service.prepare === undefined) throw new Error("Router prepare is unavailable");
  await Effect.runPromise(fixture.service.prepare({ defaultDomain: "lndo.site" }));
  expect(fixture.guestProbes).toBe(0);
  expect(fixture.readinessCalls).toBe(0);
});
