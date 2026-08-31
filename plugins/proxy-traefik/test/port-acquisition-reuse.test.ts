import { describe, expect, test } from "bun:test";
import { Cause, Effect, type Exit } from "effect";

import * as sdkErrors from "@lando/sdk/errors";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { persistPortAcquisition } from "../src/port-acquisition-state.ts";
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
    readonly fingerprint?: {
      readonly http: readonly number[];
      readonly https: readonly number[];
      readonly bindAddress: string;
    };
    readonly notices?: readonly string[];
  },
) => {
  files.set(
    acquisitionStateFile(paths),
    `${JSON.stringify({
      mode: "occupied-hop",
      httpPort: fields.httpPort,
      httpsPort: fields.httpsPort,
      notices: fields.notices ?? [],
      fingerprint: fields.fingerprint ?? defaultFingerprint,
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

const overrideFor = (fields: {
  readonly httpFirstFree: number;
  readonly httpsFirstFree: number;
  readonly httpHolder?: string;
  readonly httpsHolder?: string;
  readonly httpForward?: ForwardOutcome;
  readonly httpsForward?: ForwardOutcome;
}): ClassifyOverride => {
  const httpBinds = portBinds(HTTP_TRY_LIST, fields.httpFirstFree);
  const httpsBinds = portBinds(HTTPS_TRY_LIST, fields.httpsFirstFree);
  return {
    http: {
      bind: httpBinds[80] ?? bind("EADDRINUSE"),
      forward: fields.httpForward ?? forward("failure"),
      ...(fields.httpHolder === undefined ? {} : { holder: fields.httpHolder }),
    },
    https: {
      bind: httpsBinds[443] ?? bind("EADDRINUSE"),
      forward: fields.httpsForward ?? forward("failure"),
      ...(fields.httpsHolder === undefined ? {} : { holder: fields.httpsHolder }),
    },
    httpBinds,
    httpsBinds,
  };
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
  extra: Record<string, unknown> = {},
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
  ...extra,
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

describe("persistPortAcquisition reuse", () => {
  test("Given matching fingerprint and owned binds, When persisting, Then the chosen pair is reused", async () => {
    // Given: persisted 8080/8443, same lists+bindAddress, EADDRINUSE+ours on both.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const deps = makeDeps(store, own8080Override());

    // When: persist runs.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: reuse 8080/8443 instead of walking to the next free port.
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
    expect(readJson(store.files).fingerprint).toEqual(defaultFingerprint);
  });

  test("Given persisted notices and owned binds, When reusing, Then decision notices are empty", async () => {
    // Given: prior acquisition stored an occupancy notice; pair is still owned.
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      notices: [
        "Port 80 is occupied by nginx; using 8080. Stop the holder then run `lando global:restart` (or re-run setup) to restore 80/443.",
      ],
    });
    const deps = makeDeps(store, own8080Override());

    // When: persist reuses the pair.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: reuse does not re-surface acquisition-time notices for setup to warn on.
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
    expect(decision.notices).toEqual([]);
  });

  test("Given a changed fingerprint, When persisting, Then acquisition rescans the new try list", async () => {
    // Given: persisted 8080/8443 under the default fingerprint; lists now start at 8888/4443.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const classifyOverride = overrideFor({
      httpFirstFree: 8888,
      httpsFirstFree: 4443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const deps = makeDeps(store, classifyOverride, {
      fingerprint: {
        http: [8888, 38080],
        https: [4443, 38443],
        bindAddress: LOOPBACK,
      },
    });

    // When: persist runs against the new lists.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: rescan chooses 8888/4443, not the stale 8080 pair.
    expect(decision.httpPort).toBe(8888);
    expect(decision.httpsPort).toBe(4443);
  });

  test("Given chosen 8080 is not owned, When persisting, Then acquisition rescans", async () => {
    // Given: persisted 8080/8443, fingerprint matches, but 8080 is a foreign bind.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const classifyOverride = overrideFor({
      httpFirstFree: 8000,
      httpsFirstFree: 4443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const deps = makeDeps(store, classifyOverride);

    // When: persist cannot re-acquire the persisted pair.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: walk to the next free ports instead of keeping 8080.
    expect(decision.httpPort).toBe(8000);
    expect(decision.httpsPort).toBe(4443);
  });
});

describe("router pin mismatch", () => {
  test("Given routing-state and Landofile pins that differ from the persisted pair, When persisting, Then _tag is RouterPortPinMismatch", async () => {
    // Given: Traefik is running; persisted pair is 8080/8443; Landofile pins 80/443.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    store.files.set(
      routingStateFile(paths),
      `http://127.0.0.1:${TRAEFIK_HTTP_PORT}\nhttps://127.0.0.1:${TRAEFIK_HTTPS_PORT}`,
    );
    const deps = makeDeps(store, own8080Override(), {
      routerPin: { httpPort: 80, httpsPort: 443 },
    });

    // When: persist evaluates the pin against the running pair.
    const exit = await Effect.runPromiseExit(persistPortAcquisition(deps));

    // Then: fail closed with RouterPortPinMismatch.
    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("RouterPortPinMismatch");
    expect(sdkErrors.RouterPortPinMismatch).toBeDefined();
  });

  test("Given fallbacks-only override, When persisting, Then it is not a pin", async () => {
    // Given: no httpPort/httpsPort pin; only fallback arrays replace the rest of each list.
    const store = memoryFiles();
    const classifyOverride = overrideFor({
      httpFirstFree: 8888,
      httpsFirstFree: 4443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const deps = makeDeps(store, classifyOverride, {
      router: { httpFallbacks: [8888, 38080], httpsFallbacks: [4443, 38443] },
    });

    // When: persist runs.
    const exit = await Effect.runPromiseExit(persistPortAcquisition(deps));

    // Then: fallbacks-only is not RouterPortPinMismatch; 8888 is chosen.
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.httpPort).toBe(8888);
      expect(exit.value.httpsPort).toBe(4443);
    }
  });
});

describe("RouterPortsExhausted", () => {
  test("Given every try-list port is occupied, When persisting, Then the error lists tried ports", async () => {
    // Given: every HTTP and HTTPS candidate is EADDRINUSE.
    const store = memoryFiles();
    const httpBinds = Object.fromEntries(HTTP_TRY_LIST.map((port) => [port, bind("EADDRINUSE")]));
    const httpsBinds = Object.fromEntries(HTTPS_TRY_LIST.map((port) => [port, bind("EADDRINUSE")]));
    const classifyOverride: ClassifyOverride = {
      http: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
      https: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
      httpBinds,
      httpsBinds,
    };
    const deps = makeDeps(store, classifyOverride);

    // When: persist walks both lists to exhaustion.
    const exit = await Effect.runPromiseExit(persistPortAcquisition(deps));

    // Then: fail closed naming the tried ports; do not silently hop to 38080.
    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).toBe("RouterPortsExhausted");
    expect(sdkErrors.RouterPortsExhausted).toBeDefined();
    if (exit._tag === "Failure") {
      const squashed = Cause.squash(exit.cause);
      const dumped = JSON.stringify(squashed);
      for (const port of HTTP_TRY_LIST) {
        expect(dumped).toContain(String(port));
      }
      for (const port of HTTPS_TRY_LIST) {
        expect(dumped).toContain(String(port));
      }
    }
  });
});

describe("ownership without HTTP GET", () => {
  test("Given EADDRINUSE+ours or helper TCP forward, When checking reuse, Then HTTP GET is not the ownership probe", async () => {
    // Given: persisted 8080 answers HTTP GET via a foreign holder; TCP says we do not own it.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const classifyOverride = overrideFor({
      httpFirstFree: 8000,
      httpsFirstFree: 4443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
      httpForward: forward("success"),
      httpsForward: forward("success"),
    });
    const deps = makeDeps(store, classifyOverride);

    // When: persist decides whether 8080 is still ours.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: GET success does not count as ownership; rescan to 8000/4443.
    expect(decision.httpPort).toBe(8000);
    expect(decision.httpsPort).toBe(4443);
  });

  test("Given helper TCP forward on the persisted pair, When persisting, Then the pair is reused", async () => {
    // Given: fingerprint matches; helper forward owns 8080/8443 even though bind is EADDRINUSE.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const httpBinds = { ...portBinds(HTTP_TRY_LIST, 8000) };
    const httpsBinds = { ...portBinds(HTTPS_TRY_LIST, 4443) };
    httpBinds[8080] = bind("EADDRINUSE");
    httpsBinds[8443] = bind("EADDRINUSE");
    const classifyOverride: ClassifyOverride = {
      http: {
        bind: bind("EADDRINUSE"),
        forward: forward("success"),
        holder: "docker-proxy",
      },
      https: {
        bind: bind("EADDRINUSE"),
        forward: forward("success"),
        holder: "docker-proxy",
      },
      httpBinds,
      httpsBinds,
    };
    const deps = makeDeps(store, classifyOverride);

    // When: persist checks ownership via EADDRINUSE+ours or helper TCP forward.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: helper TCP forward counts as owned; 8080 is reused.
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
  });
});

describe("fallback notice", () => {
  test("Given occupied preferred and a chosen fallback, When persisting, Then the notice names occupied, chosen, holder, and lando global:restart", async () => {
    // Given: 80/443 held by nginx; 8080/8443 are the first free binds.
    const store = memoryFiles();
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const deps = makeDeps(store, classifyOverride);

    // When: persist chooses the fallback pair.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: notice body carries occupied preferred, chosen fallback, holder, and restart.
    expect(decision.notices).toEqual([
      "Port 80 is occupied by nginx; using 8080. Stop the holder then run `lando global:restart` (or re-run setup) to restore 80/443.",
      "Port 443 is occupied by nginx; using 8443. Stop the holder then run `lando global:restart` (or re-run setup) to restore 80/443.",
    ]);
  });

  test("Given occupied preferred, When setup runs, Then message.warn names occupied, chosen, holder, and lando global:restart", async () => {
    // Given: 80/443 held by nginx; EventService captures acquisition-time warn.
    const store = memoryFiles();
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const bodies: string[] = [];
    const service = makeTraefikProxyService(
      makeDeps(store, classifyOverride, {
        events: {
          publish: (event: { readonly _tag: string; readonly body?: string }) =>
            Effect.sync(() => {
              if (event._tag === "message.warn" && event.body !== undefined) {
                bodies.push(event.body);
              }
            }),
        },
      }),
    );

    // When: setup acquires the fallback pair.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: the warn body is the user-visible notice, not only decision.notices.
    const joined = bodies.join(" ");
    expect(joined).toContain("80");
    expect(joined).toContain("8080");
    expect(joined).toContain("nginx");
    expect(joined).toContain("lando global:restart");
  });
});

describe("chosen 8080 vs routing-state", () => {
  test("Given fallback 8080, When setup persists, Then 8080 is in acquisition JSON and routing-state", async () => {
    // Given: preferred 80/443 occupied; 8080/8443 bind.
    const store = memoryFiles();
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const service = makeTraefikProxyService(makeDeps(store, classifyOverride));

    // When: setup writes acquisition JSON and routing-state.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: chosen 8080/8443 are in acquisition JSON and advertised in routing-state.
    expect(readJson(store.files).httpPort).toBe(8080);
    expect(readJson(store.files).httpsPort).toBe(8443);
    const routing = store.files.get(routingStateFile(paths)) ?? "";
    expect(routing).toContain(":8080");
    expect(routing).toContain(":8443");
  });

  test("Given chosen 8080, When setup writes routing-state, Then advertised ports are the chosen pair", async () => {
    // Given: try-list fallback chose 8080/8443.
    const store = memoryFiles();
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const service = makeTraefikProxyService(makeDeps(store, classifyOverride));

    // When: setup persists advertised authorities.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: routing-state advertises the chosen pair, not the frozen high pair.
    const routing = store.files.get(routingStateFile(paths)) ?? "";
    expect(readJson(store.files).httpPort).toBe(8080);
    expect(routing).toContain(":8080");
    expect(routing).toContain(":8443");
    expect(routing).not.toContain(`:${TRAEFIK_HTTP_PORT}`);
    expect(routing).not.toContain(`:${TRAEFIK_HTTPS_PORT}`);
  });
});

describe("ownership probe bind address", () => {
  test("Given fingerprint bindAddress 0.0.0.0, When checking reuse, Then probeBind uses that address", async () => {
    // Given: persisted pair under bindAddress 0.0.0.0; no classifyOverride so ownership uses probeBind.
    const store = memoryFiles();
    const fingerprint = {
      http: [...HTTP_TRY_LIST],
      https: [...HTTPS_TRY_LIST],
      bindAddress: "0.0.0.0",
    } as const;
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443, fingerprint });
    const probedHosts: string[] = [];
    const { socketProxy: _unusedSocketProxy, ...deps } = makeDeps(store, own8080Override(), {
      fingerprint,
      probeBind: (host: string) => {
        probedHosts.push(host);
        return Effect.succeed(bind("success"));
      },
    });

    // When: persist checks whether the previous pair is still owned.
    await Effect.runPromiseExit(persistPortAcquisition(deps));

    // Then: ownership probes 0.0.0.0, not loopback.
    expect(probedHosts.includes("0.0.0.0")).toBe(true);
    expect(probedHosts.includes("127.0.0.1")).toBe(false);
  });
});
