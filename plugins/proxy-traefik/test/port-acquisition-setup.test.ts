import { describe, expect, test } from "bun:test";
import { Cause, Effect, type Exit } from "effect";

import { makeTestCertificateAuthority } from "@lando/sdk/test";

import {
  type BindOutcome,
  DEFAULT_HTTPS_TRY_LIST,
  DEFAULT_HTTP_TRY_LIST,
  type ForwardOutcome,
  LOOPBACK_HOST,
  type SchemeProbe,
} from "../src/port-acquisition.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "../src/ports.ts";
import { acquisitionStateFile, routingStateFile } from "../src/proxy-paths.ts";
import type { TraefikProxyDependencies } from "../src/proxy-types.ts";
import { makeTraefikProxyService } from "../src/proxy.ts";

const LOOPBACK = LOOPBACK_HOST;
const HTTP_TRY_LIST = DEFAULT_HTTP_TRY_LIST;
const HTTPS_TRY_LIST = DEFAULT_HTTPS_TRY_LIST;
const paths = { platform: "linux" as const, globalAppRoot: "/lando/global" };

const bind = (kind: BindOutcome["kind"]): BindOutcome => {
  switch (kind) {
    case "success":
      return { kind: "success" };
    case "EADDRINUSE":
      return { kind: "EADDRINUSE", code: "EADDRINUSE" };
    case "EACCES":
      return { kind: "EACCES", code: "EACCES" };
    case "other-error":
      return { kind: "other-error" };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unexpected bind kind: ${String(exhaustive)}`);
    }
  }
};

const forward = (kind: ForwardOutcome["kind"]): ForwardOutcome => ({ kind });

const portBinds = (list: readonly number[], firstFree: number): Readonly<Record<number, BindOutcome>> => {
  const binds: Record<number, BindOutcome> = {};
  let seenFree = false;
  for (const port of list) {
    if (!seenFree && port === firstFree) {
      binds[port] = bind("success");
      seenFree = true;
      continue;
    }
    binds[port] = seenFree ? bind("success") : bind("EADDRINUSE");
  }
  return binds;
};

const unusedRunner = {
  run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  stream: () => {
    throw new Error("stream is unused");
  },
};

const unusedPrivilege = {
  elevate: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
};

const memoryFiles = () => {
  const files = new Map<string, string>();
  return {
    files,
    fileSystem: {
      mkdir: () => Effect.void,
      writeAtomic: (path: string, content: string | Uint8Array) =>
        Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path: string, content: string | Uint8Array) =>
        Effect.sync(() => void files.set(path, String(content))),
      remove: (path: string) => Effect.sync(() => void files.delete(path)),
      exists: (path: string) =>
        Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
      readDir: (path: string) =>
        Effect.succeed(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1)),
        ),
      readText: (path: string) =>
        files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
    },
  };
};

const defaultFingerprint = {
  http: [...HTTP_TRY_LIST],
  https: [...HTTPS_TRY_LIST],
  bindAddress: LOOPBACK,
} as const;

const seedAcquisition = (
  files: Map<string, string>,
  fields: {
    readonly httpPort: number;
    readonly httpsPort: number;
  },
) => {
  files.set(
    acquisitionStateFile(paths),
    `${JSON.stringify({
      mode: "occupied-hop",
      httpPort: fields.httpPort,
      httpsPort: fields.httpsPort,
      notices: [],
      fingerprint: defaultFingerprint,
      helperInstalled: false,
      socketsActive: false,
    })}\n`,
  );
};

type ClassifyOverride = {
  readonly http: SchemeProbe;
  readonly https: SchemeProbe;
  readonly httpBinds: Readonly<Record<number, BindOutcome>>;
  readonly httpsBinds: Readonly<Record<number, BindOutcome>>;
};

const own8080Override = (): ClassifyOverride => {
  const httpBinds = { ...portBinds(HTTP_TRY_LIST, 8000) };
  const httpsBinds = { ...portBinds(HTTPS_TRY_LIST, 4443) };
  httpBinds[8080] = bind("EADDRINUSE");
  httpsBinds[8443] = bind("EADDRINUSE");
  return {
    http: {
      bind: bind("EADDRINUSE"),
      forward: forward("failure"),
      holder: "traefik",
    },
    https: {
      bind: bind("EADDRINUSE"),
      forward: forward("failure"),
      holder: "traefik",
    },
    httpBinds,
    httpsBinds,
  };
};

const makeDeps = (
  store: ReturnType<typeof memoryFiles>,
  classifyOverride: ClassifyOverride,
): TraefikProxyDependencies => ({
  certificateAuthority: makeTestCertificateAuthority(),
  fileSystem: store.fileSystem,
  paths,
  globalApp: {
    ensureRunning: () =>
      Effect.succeed([
        {
          name: "traefik",
          state: "running",
          endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
        },
      ]),
  },
  socketProxy: {
    user: "test",
    hasHostSystemd: () => false,
    exists: () => Effect.succeed(false),
    readText: () => Effect.fail(new Error("missing")),
    processRunner: unusedRunner,
    privilege: unusedPrivilege,
    classifyOverride,
  },
});

const readJson = (files: Map<string, string>): Record<string, unknown> => {
  const raw = files.get(acquisitionStateFile(paths));
  return JSON.parse(raw ?? "null") as Record<string, unknown>;
};

const failureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (exit._tag !== "Failure") return undefined;
  const squashed = Cause.squash(exit.cause);
  if (typeof squashed === "object" && squashed !== null && "_tag" in squashed) {
    return String(squashed._tag);
  }
  return undefined;
};

const squashedFields = (exit: Exit.Exit<unknown, unknown>): Record<string, unknown> => {
  if (exit._tag !== "Failure") return {};
  const squashed = Cause.squash(exit.cause);
  if (typeof squashed === "object" && squashed !== null) {
    return squashed as Record<string, unknown>;
  }
  return {};
};

describe("setup router lists", () => {
  test("Given occupied 80/443 and free 9090/9443, When setup receives router lists, Then acquisition chooses 9090/9443", async () => {
    // Given: 80/443 occupied; custom try lists [9090,9091] and [9443,9444] bind.
    const store = memoryFiles();
    const classifyOverride: ClassifyOverride = {
      http: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
      https: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
      httpBinds: {
        ...portBinds(HTTP_TRY_LIST, 8080),
        ...portBinds([9090, 9091], 9090),
      },
      httpsBinds: {
        ...portBinds(HTTPS_TRY_LIST, 8443),
        ...portBinds([9443, 9444], 9443),
      },
    };
    const service = makeTraefikProxyService(makeDeps(store, classifyOverride));

    // When: setup is given router lists, not deps.router.
    await Effect.runPromise(
      Effect.scoped(
        service.setup({
          defaultDomain: "lndo.site",
          router: {
            httpPort: 9090,
            httpFallbacks: [9091],
            httpsPort: 9443,
            httpsFallbacks: [9444],
          },
        }),
      ),
    );

    // Then: chosen ports come from config.router, not compiled defaults.
    expect(readJson(store.files).httpPort).toBe(9090);
    expect(readJson(store.files).httpsPort).toBe(9443);
    expect(readJson(store.files).notices).toEqual([]);
  });

  test("Given httpPort without fallbacks, When setup runs, Then acquisition prefers that port not 80", async () => {
    // Given: 80/443 and 9080/9443 all bind; router names 9080/9443 with no fallback arrays.
    const store = memoryFiles();
    const classifyOverride: ClassifyOverride = {
      http: { bind: bind("success"), forward: forward("failure") },
      https: { bind: bind("success"), forward: forward("failure") },
      httpBinds: { ...portBinds(HTTP_TRY_LIST, 80), 9080: bind("success") },
      httpsBinds: { ...portBinds(HTTPS_TRY_LIST, 443), 9443: bind("success") },
    };
    const service = makeTraefikProxyService(makeDeps(store, classifyOverride));

    // When: setup receives preferred ports only.
    await Effect.runPromise(
      Effect.scoped(
        service.setup({
          defaultDomain: "lndo.site",
          router: { httpPort: 9080, httpsPort: 9443 },
        }),
      ),
    );

    // Then: httpPort replaced the preferred candidate; 80 was not chosen.
    expect(readJson(store.files).httpPort).toBe(9080);
    expect(readJson(store.files).httpsPort).toBe(9443);
    expect(readJson(store.files).notices).toEqual([]);
  });
});

describe("setup routing-state", () => {
  test("Given ensureRunning fails, When setup runs, Then routing-state is not written", async () => {
    // Given: acquisition can choose ports, but Traefik start fails.
    const store = memoryFiles();
    const deps = makeDeps(store, {
      http: { bind: bind("success"), forward: forward("failure") },
      https: { bind: bind("success"), forward: forward("failure") },
      httpBinds: portBinds(HTTP_TRY_LIST, 80),
      httpsBinds: portBinds(HTTPS_TRY_LIST, 443),
    });
    const service = makeTraefikProxyService({
      ...deps,
      globalApp: {
        ensureRunning: () => Effect.fail(new Error("traefik start failed")),
      },
    });

    // When: setup fails during ensureRunning.
    const exit = await Effect.runPromiseExit(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: pin-mismatch must not see a routing-state file from a failed start.
    expect(exit._tag).toBe("Failure");
    expect(store.files.has(routingStateFile(paths))).toBe(false);
  });
});

describe("setup router pin", () => {
  test("Given a persisted running pair, When setup receives a differing routerPin, Then _tag is RouterPortPinMismatch", async () => {
    // Given: Traefik is running; persisted pair is 8080/8443; Landofile pins 80/443.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    store.files.set(
      routingStateFile(paths),
      `http://127.0.0.1:${TRAEFIK_HTTP_PORT}\nhttps://127.0.0.1:${TRAEFIK_HTTPS_PORT}`,
    );
    const service = makeTraefikProxyService(makeDeps(store, own8080Override()));

    // When: setup is given routerPin, not deps.routerPin.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        service.setup({
          defaultDomain: "lndo.site",
          routerPin: { httpPort: 80, httpsPort: 443 },
        }),
      ),
    );

    // Then: fail closed with the running pair on the mismatch.
    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("RouterPortPinMismatch");
    expect(squashedFields(exit).runningHttp).toBe(8080);
    expect(squashedFields(exit).runningHttps).toBe(8443);
  });
});

describe("setup exhausted lists", () => {
  test("Given every try-list port is occupied, When setup runs, Then _tag is RouterPortsExhausted", async () => {
    // Given: every HTTP and HTTPS candidate is EADDRINUSE.
    const store = memoryFiles();
    const httpBinds = Object.fromEntries(HTTP_TRY_LIST.map((port) => [port, bind("EADDRINUSE")]));
    const httpsBinds = Object.fromEntries(HTTPS_TRY_LIST.map((port) => [port, bind("EADDRINUSE")]));
    const service = makeTraefikProxyService(
      makeDeps(store, {
        http: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
        https: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
        httpBinds,
        httpsBinds,
      }),
    );

    // When: setup walks both lists to exhaustion.
    const exit = await Effect.runPromiseExit(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: proxy start fails closed with the tried ports; it is not silently disabled.
    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("RouterPortsExhausted");
    const dumped = JSON.stringify(squashedFields(exit));
    for (const port of HTTP_TRY_LIST) {
      expect(dumped).toContain(String(port));
    }
    for (const port of HTTPS_TRY_LIST) {
      expect(dumped).toContain(String(port));
    }
  });
});

describe("setup try-list probe walk", () => {
  test("Given probeBind records ports, When setup runs, Then default HTTP then HTTPS lists are probed in order", async () => {
    // Given: no classifyOverride, so setup walks probeBind over the production lists.
    const store = memoryFiles();
    const probed: number[] = [];
    const service = makeTraefikProxyService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: store.fileSystem,
      paths,
      globalApp: {
        ensureRunning: () =>
          Effect.succeed([
            {
              name: "traefik",
              state: "running",
              endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
            },
          ]),
      },
      probeBind: (_host, port) => {
        probed.push(port);
        return Effect.succeed(bind("success"));
      },
    });

    // When: setup acquires ports through persistPortAcquisition → probeTryList.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: every default candidate is probed in order; first success wins.
    expect(probed).toEqual([...HTTP_TRY_LIST, ...HTTPS_TRY_LIST]);
    expect(readJson(store.files).httpPort).toBe(80);
    expect(readJson(store.files).httpsPort).toBe(443);
  });
});
