import { describe, expect, test } from "bun:test";
import * as sdkErrors from "@lando/sdk/errors";
import type { ServiceName } from "@lando/sdk/schema";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Cause, Effect, type Exit } from "effect";
import { buildTraefikServiceConfig } from "../src/global-services/traefik.ts";
import {
  type BindOutcome,
  DEFAULT_HTTPS_TRY_LIST,
  DEFAULT_HTTP_TRY_LIST,
  type ForwardOutcome,
  LOOPBACK_HOST,
  type SchemeProbe,
} from "../src/port-acquisition.ts";
import { stillOwnPersisted } from "../src/port-acquisition-helpers.ts";
import { persistPortAcquisition } from "../src/port-acquisition-state.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "../src/ports.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisitionStateFile, routingStateFile } from "../src/proxy-paths.ts";
import type { TraefikProxyDependencies } from "../src/proxy-types.ts";
import { resolvePublishedRouterBindAddress } from "../src/router-bind-address.ts";
import {
  LANDO_SOCKET_PROXY_HOLDER_LABEL,
  socketProxyPolkitHeader,
  socketProxyUnitHeader,
} from "../src/socket-proxy-helper.ts";
import { SOCKET_UNIT_PATHS } from "../src/socket-proxy-units.ts";
import { socketProxyControlCommands } from "./_support/socket-proxy-commands.ts";

const LOOPBACK = LOOPBACK_HOST;
const HTTP_TRY_LIST = DEFAULT_HTTP_TRY_LIST;
const HTTPS_TRY_LIST = DEFAULT_HTTPS_TRY_LIST;
const USER_DATA_ROOT = "/lando/user-data";
const paths = { platform: "linux" as const, globalAppRoot: "/lando/global", userDataRoot: USER_DATA_ROOT };
const UNIT_HEADER = socketProxyUnitHeader(USER_DATA_ROOT);
const POLKIT_HEADER = socketProxyPolkitHeader(USER_DATA_ROOT);
const POLKIT_PATH = "/etc/polkit-1/rules.d/10-lando-proxy.rules";
const OWNED_UNIT_PATHS = [
  "/etc/systemd/system/lando-proxy-http.socket",
  "/etc/systemd/system/lando-proxy-http.service",
  "/etc/systemd/system/lando-proxy-https.socket",
  "/etc/systemd/system/lando-proxy-https.service",
] as const;

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
  streamWithExit: () => {
    throw new Error("streamWithExit is unused");
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
    readonly mode?: "direct" | "occupied-hop" | "needs-helper" | "socket-helper";
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
      mode: fields.mode ?? "occupied-hop",
      httpPort: fields.httpPort,
      httpsPort: fields.httpsPort,
      notices: fields.notices ?? [],
      fingerprint: fields.fingerprint ?? defaultFingerprint,
      helperInstalled: false,
      socketsActive: false,
    })}\n`,
  );
};

const seedOwnedHelperUnits = (
  files: Map<string, string>,
  hops: { readonly http: number; readonly https: number } = { http: 8080, https: 8443 },
) => {
  files.set(OWNED_UNIT_PATHS[0], `${UNIT_HEADER}\n`);
  files.set(
    OWNED_UNIT_PATHS[1],
    `${UNIT_HEADER}\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:${hops.http}\n`,
  );
  files.set(OWNED_UNIT_PATHS[2], `${UNIT_HEADER}\n`);
  files.set(
    OWNED_UNIT_PATHS[3],
    `${UNIT_HEADER}\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:${hops.https}\n`,
  );
  files.set(POLKIT_PATH, `${POLKIT_HEADER}\n`);
  files.set("/usr/lib/systemd/systemd-socket-proxyd", "ok");
};

const ownedPublishPorts =
  (ports: readonly number[]) =>
  (_service: ReturnType<typeof ServiceName.make>, requested: readonly number[]) =>
    Effect.succeed(requested.filter((port) => ports.includes(port)));

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
  readonly httpUnit?: string;
  readonly httpsUnit?: string;
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
      ...(fields.httpUnit === undefined ? {} : { holderSystemdUnit: fields.httpUnit }),
    },
    https: {
      bind: httpsBinds[443] ?? bind("EADDRINUSE"),
      forward: fields.httpsForward ?? forward("failure"),
      ...(fields.httpsHolder === undefined ? {} : { holder: fields.httpsHolder }),
      ...(fields.httpsUnit === undefined ? {} : { holderSystemdUnit: fields.httpsUnit }),
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
  probeForward: () => Effect.succeed({ kind: "success" as const }),
  socketProxy: {
    user: "test",
    userDataRoot: USER_DATA_ROOT,
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
  test("selects 48080 when provider ownership lookup fails for occupied helper backends", async () => {
    const store = memoryFiles();
    seedOwnedHelperUnits(store.files);
    const calls: string[] = [];
    const override: ClassifyOverride = {
      http: { bind: bind("EACCES"), forward: forward("failure"), holder: "rootlessport" },
      https: { bind: bind("EACCES"), forward: forward("failure"), holder: "rootlessport" },
      httpBinds: { 80: bind("EACCES"), 38080: bind("EADDRINUSE"), 48080: bind("success") },
      httpsBinds: { 443: bind("EACCES"), 38443: bind("EADDRINUSE"), 48443: bind("success") },
    };
    const dependencies = makeDeps(store, override);
    const decision = await Effect.runPromise(
      persistPortAcquisition({
        ...dependencies,
        globalApp: {
          ...dependencies.globalApp,
          ownedPublishPorts: () => Effect.fail(new Error("provider unavailable")),
        },
        socketProxy: {
          user: "test",
          userDataRoot: USER_DATA_ROOT,
          hasHostSystemd: () => true,
          autoApprove: true,
          exists: (path) => Effect.succeed(store.files.has(path)),
          readText: (path) => Effect.succeed(store.files.get(path) ?? ""),
          processRunner: unusedRunner,
          privilege: {
            elevate: (command) =>
              Effect.sync(() => {
                calls.push(command[2] ?? "");
                return { exitCode: 0, stdout: "", stderr: "" };
              }),
          },
          classifyOverride: override,
          probeForward: () => Effect.succeed({ kind: "success" }),
        },
      }),
    );
    expect(decision.mode).toBe("socket-helper");
    expect(readJson(store.files).bindHttpPort).toBe(48080);
    expect(readJson(store.files).bindHttpsPort).toBe(48443);
    expect(calls).toHaveLength(1);
  });

  test("Given matching fingerprint and owned binds, When persisting, Then the chosen pair is reused", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const deps = makeDeps(store, own8080Override(), {
      globalApp: {
        ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
        ownedPublishPorts: ownedPublishPorts([8080, 8443]),
      },
    });

    // When: persist runs.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: reuse 8080/8443 instead of walking to the next free port.
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
    expect(readJson(store.files).fingerprint).toEqual(defaultFingerprint);
  });

  test("does not reuse persisted ports outside the current candidate lists", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 9999, httpsPort: 9998 });
    const deps = makeDeps(store, overrideFor({ httpFirstFree: 8080, httpsFirstFree: 8443 }));

    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
  });

  test("Given persisted occupied-hop and owned binds, When reusing, Then occupancy warning is re-emitted", async () => {
    // Given: prior acquisition stored an occupancy notice; pair is still owned.
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      notices: ["stale"],
    });
    const deps = makeDeps(store, own8080Override(), {
      globalApp: {
        ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
        ownedPublishPorts: ownedPublishPorts([8080, 8443]),
      },
    });

    // When: persist reuses the pair.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: reuse still warns that preferred ports are not advertised.
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
    expect(decision.notices.length).toBeGreaterThan(0);
    expect(decision.notices.join(" ")).toContain("8080");
    expect(decision.notices.join(" ")).toContain("lando info");
  });

  test("rewrites a stale 0.0.0.0 fingerprint before Traefik publishes a narrowed bind", async () => {
    // Given: setup already published on every interface; global config now asks for loopback.
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      fingerprint: {
        http: [...HTTP_TRY_LIST],
        https: [...HTTPS_TRY_LIST],
        bindAddress: "0.0.0.0",
      },
    });
    const deps = makeDeps(store, overrideFor({ httpFirstFree: 8080, httpsFirstFree: 8443 }), {
      fingerprint: {
        http: [...HTTP_TRY_LIST],
        https: [...HTTPS_TRY_LIST],
        bindAddress: "0.0.0.0",
      },
      router: { bindAddress: "127.0.0.1" },
    });

    // When: start-path persist runs with the narrowed router bind.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));
    const persisted = readJson(store.files);
    const fingerprint = persisted.fingerprint as { bindAddress: string };
    const published = buildTraefikServiceConfig({
      http: decision.httpPort,
      https: decision.httpsPort,
      bindAddress: resolvePublishedRouterBindAddress(fingerprint.bindAddress, "0.0.0.0"),
    });

    // Then: the rewritten fingerprint, not the stale 0.0.0.0 state, is what Traefik publishes.
    expect(decision.fingerprint.bindAddress).toBe("127.0.0.1");
    expect(fingerprint.bindAddress).toBe("127.0.0.1");
    expect(
      (published.endpoints ?? [])
        .filter((endpoint) => endpoint._tag === "published")
        .map((endpoint) => endpoint.publication.bindAddress),
    ).toEqual(["127.0.0.1", "127.0.0.1"]);
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

  test("Given provider-owned EADDRINUSE on the persisted pair, When persisting, Then the pair is reused", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const httpBinds = { ...portBinds(HTTP_TRY_LIST, 8000) };
    const httpsBinds = { ...portBinds(HTTPS_TRY_LIST, 4443) };
    httpBinds[8080] = bind("EADDRINUSE");
    httpsBinds[8443] = bind("EADDRINUSE");
    const classifyOverride: ClassifyOverride = {
      http: {
        bind: bind("EADDRINUSE"),
        forward: forward("failure"),
        holder: "rootlessport",
      },
      https: {
        bind: bind("EADDRINUSE"),
        forward: forward("failure"),
        holder: "rootlessport",
      },
      httpBinds,
      httpsBinds,
    };
    const deps = makeDeps(store, classifyOverride, {
      globalApp: {
        ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
        ownedPublishPorts: ownedPublishPorts([8080, 8443]),
      },
    });

    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
  });
});

describe("fallback notice", () => {
  test("Given occupied preferred and a chosen fallback, When persisting, Then the notice names occupied, chosen, holder, and lando info", async () => {
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
    expect(decision.notices).toHaveLength(2);
    expect(decision.notices[0]).toContain("80");
    expect(decision.notices[0]).toContain("8080");
    expect(decision.notices[0]).toContain("nginx");
    expect(decision.notices.join("\n").match(/alternate URL is available/gu)).toHaveLength(1);
    expect(decision.notices[1]).toContain("lando info");
    expect(decision.notices[1]).toContain("443");
    expect(decision.notices[1]).toContain("8443");
  });

  test("Given occupied preferred, When setup runs, Then message.warn names occupied, chosen, holder, and lando info", async () => {
    // Given: 80/443 held by nginx; EventService captures acquisition-time warn.
    const store = memoryFiles();
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });
    const bodies: string[] = [];
    const service = makeTraefikRouterService(
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
    expect(joined).toContain("lando info");
    expect(joined.match(/alternate URL is available/gu)).toHaveLength(1);
  });

  test("Given unchanged persisted occupied-hop pair, When ensure setup runs, Then message.warn is suppressed and notices stay persisted", async () => {
    const store = memoryFiles();
    const persistedNotice =
      "Port 80 is occupied by nginx. Lando is using 8080 instead.\nRun lando info for the alternate URL.";
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      mode: "occupied-hop",
      notices: [persistedNotice],
    });
    const bodies: string[] = [];
    const service = makeTraefikRouterService(
      makeDeps(store, own8080Override(), {
        globalApp: {
          ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
          ownedPublishPorts: ownedPublishPorts([8080, 8443]),
        },
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

    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    expect(bodies).toEqual([]);
    const persisted = readJson(store.files);
    expect(persisted.mode).toBe("occupied-hop");
    expect(persisted.httpPort).toBe(8080);
    expect(persisted.httpsPort).toBe(8443);
    expect(JSON.stringify(persisted.notices)).toContain("8080");
    expect(JSON.stringify(persisted.notices)).toContain("lando info");
  });

  test("Given changed persisted pair, When ensure setup runs, Then message.warn publishes the new fallback", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      mode: "occupied-hop",
      notices: ["stale pair"],
    });
    const bodies: string[] = [];
    const service = makeTraefikRouterService(
      makeDeps(
        store,
        overrideFor({
          httpFirstFree: 8000,
          httpsFirstFree: 4443,
          httpHolder: "nginx",
          httpsHolder: "nginx",
        }),
        {
          events: {
            publish: (event: { readonly _tag: string; readonly body?: string }) =>
              Effect.sync(() => {
                if (event._tag === "message.warn" && event.body !== undefined) {
                  bodies.push(event.body);
                }
              }),
          },
        },
      ),
    );

    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    const persisted = readJson(store.files);
    expect(persisted.httpPort).toBe(8000);
    expect(persisted.httpsPort).toBe(4443);
    expect(persisted.mode).toBe("occupied-hop");
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("8000");
    expect(bodies[0]).toContain("lando info");
    expect(JSON.stringify(persisted.notices)).toContain("8000");
  });

  test("Given unchanged occupied-hop pair, When configure setup runs, Then message.warn always publishes", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      mode: "occupied-hop",
      notices: ["prior occupancy notice with lando info"],
    });
    const bodies: string[] = [];
    const service = makeTraefikRouterService(
      makeDeps(store, own8080Override(), {
        globalApp: {
          ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
          ownedPublishPorts: ownedPublishPorts([8080, 8443]),
        },
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

    await Effect.runPromise(
      Effect.scoped(service.setup({ defaultDomain: "lndo.site" }, { intent: "configure" })),
    );

    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain("8080");
    expect(bodies[0]).toContain("lando info");
    expect(JSON.stringify(readJson(store.files).notices)).toContain("8080");
  });
});

describe("bind narrowing on start and setup", () => {
  test("prepare rewrites a stale 0.0.0.0 fingerprint so Traefik would publish loopback", async () => {
    // Given: a running router published on every interface.
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      fingerprint: {
        http: [...HTTP_TRY_LIST],
        https: [...HTTPS_TRY_LIST],
        bindAddress: "0.0.0.0",
      },
    });
    const service = makeTraefikRouterService(
      makeDeps(store, overrideFor({ httpFirstFree: 8080, httpsFirstFree: 8443 })),
    );
    const prepare = service.prepare;
    if (prepare === undefined) throw new TypeError("Traefik router prepare is missing");

    // When: start-path prepare runs with the narrowed global bind.
    await Effect.runPromise(
      Effect.scoped(prepare({ defaultDomain: "lndo.site", router: { bindAddress: "127.0.0.1" } })),
    );
    const persisted = readJson(store.files);
    const fingerprint = persisted.fingerprint as { bindAddress: string };
    const published = buildTraefikServiceConfig({
      http: 8080,
      https: 8443,
      bindAddress: resolvePublishedRouterBindAddress(fingerprint.bindAddress, "0.0.0.0"),
    });

    // Then: the file Traefik reads during ensureGlobalServicesRunning is already loopback.
    expect(fingerprint.bindAddress).toBe("127.0.0.1");
    expect(
      (published.endpoints ?? [])
        .filter((endpoint) => endpoint._tag === "published")
        .map((endpoint) => endpoint.publication.bindAddress),
    ).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  test("setup persist rewrites the bind before ensureRunning builds Traefik", async () => {
    // Given: stale every-interface state; setup ensureRunning snapshots acquisition after persist.
    const store = memoryFiles();
    seedAcquisition(store.files, {
      httpPort: 8080,
      httpsPort: 8443,
      fingerprint: {
        http: [...HTTP_TRY_LIST],
        https: [...HTTPS_TRY_LIST],
        bindAddress: "0.0.0.0",
      },
    });
    const applied: Array<{ bindAddress?: string }> = [];
    const service = makeTraefikRouterService(
      makeDeps(store, overrideFor({ httpFirstFree: 8080, httpsFirstFree: 8443 }), {
        globalApp: {
          ensureRunning: () => {
            const persisted = readJson(store.files);
            applied.push((persisted.fingerprint as { bindAddress?: string }) ?? {});
            return Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]);
          },
        },
      }),
    );

    // When: setup re-acquires the narrowed bind and then starts Traefik.
    await Effect.runPromise(
      Effect.scoped(service.setup({ defaultDomain: "lndo.site", router: { bindAddress: "127.0.0.1" } })),
    );

    // Then: ensureRunning already sees 127.0.0.1, so publication cannot keep 0.0.0.0.
    expect(applied).toEqual([expect.objectContaining({ bindAddress: "127.0.0.1" })]);
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
    const service = makeTraefikRouterService(makeDeps(store, classifyOverride));

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
    const service = makeTraefikRouterService(makeDeps(store, classifyOverride));

    // When: setup persists advertised authorities.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: routing-state advertises the chosen pair, not the default Traefik ports.
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

describe("stillOwnPersisted hop ports", () => {
  test("rejects reuse when a socket-helper hop port is held without provider ownership", async () => {
    const probeBind = (_host: string, port: number) => {
      if (port === 80 || port === 443 || port === 8080 || port === 8443) {
        return Effect.succeed(bind("EADDRINUSE"));
      }
      return Effect.succeed(bind("success"));
    };
    const { socketProxy: _socketProxy, ...deps } = makeDeps(memoryFiles(), own8080Override(), {
      probeBind,
      globalApp: {
        ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
        ownedPublishPorts: ownedPublishPorts([80, 443]),
      },
    });

    // When: ownership includes persisted bind ports.
    const owned = await Effect.runPromise(
      stillOwnPersisted(
        deps,
        {
          httpPort: 80,
          httpsPort: 443,
          helperInstalled: true,
          socketsActive: true,
          bindHttpPort: 8080,
          bindHttpsPort: 8443,
        },
        own8080Override(),
        LOOPBACK,
      ),
    );

    expect(owned).toBe(false);
  });

  test("stillOwnPersisted is false for a foreign holder without provider proof", async () => {
    const probeBind = (_host: string, port: number) =>
      port === 8080 || port === 8443 ? Effect.succeed(bind("EADDRINUSE")) : Effect.succeed(bind("success"));
    const { socketProxy: _socketProxy, ...deps } = makeDeps(memoryFiles(), own8080Override(), {
      probeBind,
      globalApp: {
        ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
        ownedPublishPorts: ownedPublishPorts([]),
      },
    });

    const owned = await Effect.runPromise(
      stillOwnPersisted(
        deps,
        {
          httpPort: 8080,
          httpsPort: 8443,
          helperInstalled: false,
          socketsActive: false,
        },
        own8080Override(),
        LOOPBACK,
      ),
    );

    expect(owned).toBe(false);
  });
});

describe("persistPortAcquisition helper-owned preferred ports", () => {
  test("Given helper installed and systemd-socket-proxyd on 80/443, When persisting, Then advertised ports are 80/443", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    seedOwnedHelperUnits(store.files, { http: 8080, https: 8443 });
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "systemd-socket-proxyd",
      httpsHolder: "systemd-socket-proxyd",
      httpUnit: "lando-proxy-http",
      httpsUnit: "lando-proxy-https",
    });
    const deps = makeDeps(store, classifyOverride, {
      socketProxy: {
        user: "test",
        userDataRoot: USER_DATA_ROOT,
        hasHostSystemd: () => true,
        exists: (path: string) => Effect.succeed(store.files.has(path)),
        readText: (path: string) =>
          store.files.has(path) ? Effect.succeed(store.files.get(path) ?? "") : Effect.fail(new Error(path)),
        processRunner: unusedRunner,
        privilege: unusedPrivilege,
        classifyOverride,
        probeForward: () => Effect.succeed({ kind: "success" as const }),
      },
    });

    // When: persist sees our helper owning 80/443.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: advertise 80/443 (socket-helper) instead of occupied-hop 8080/8443.
    expect(decision.mode).toBe("socket-helper");
    expect(decision.httpPort).toBe(80);
    expect(decision.httpsPort).toBe(443);
    expect(readJson(store.files).bindHttpPort).toBe(8080);
    expect(readJson(store.files).bindHttpsPort).toBe(8443);
  });

  test.each([false, true])(
    "probes custom unit hop targets before fast reuse (provider owned: %s)",
    async (owned) => {
      const store = memoryFiles();
      seedOwnedHelperUnits(store.files, { http: 60900, https: 60943 });
      const override = overrideFor({
        httpFirstFree: 8080,
        httpsFirstFree: 8443,
        httpHolder: "systemd-socket-",
        httpsHolder: "systemd-socket-",
        httpUnit: "lando-proxy-http",
        httpsUnit: "lando-proxy-https",
      });
      const dependencies = makeDeps(store, override);
      const probed: number[] = [];
      const commands: string[][] = [];
      const decision = await Effect.runPromise(
        persistPortAcquisition({
          ...dependencies,
          probeBind: (_host, port) =>
            Effect.sync(() => {
              probed.push(port);
              return bind("EADDRINUSE");
            }),
          globalApp: {
            ...dependencies.globalApp,
            ownedPublishPorts: ownedPublishPorts(owned ? [60900, 60943] : []),
          },
          socketProxy: {
            user: "test",
            userDataRoot: USER_DATA_ROOT,
            hasHostSystemd: () => true,
            exists: (path) => Effect.succeed(store.files.has(path)),
            readText: (path) => Effect.succeed(store.files.get(path) ?? ""),
            processRunner: {
              ...unusedRunner,
              run: (input) =>
                Effect.sync(() => {
                  commands.push([...input.args]);
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
            },
            privilege: {
              elevate: (command) =>
                Effect.sync(() => {
                  commands.push([...command]);
                  for (const match of (command[2] ?? "").matchAll(
                    /cat > (\S+) <<'LANDO_PROXY_EOF'\n([\s\S]*?)LANDO_PROXY_EOF/gu,
                  )) {
                    if (match[1] !== undefined && match[2] !== undefined) store.files.set(match[1], match[2]);
                  }
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
            },
            classifyOverride: override,
            probeForward: () => Effect.succeed({ kind: "success" }),
          },
        }),
      );
      expect(probed).toEqual([60900, 60943]);
      expect(decision.mode).toBe("socket-helper");
      expect(readJson(store.files).bindHttpPort).toBe(owned ? 60900 : 38080);
      expect(store.files.get(OWNED_UNIT_PATHS[1])).toContain(`127.0.0.1:${owned ? 60900 : 38080}`);
      expect(commands.flatMap(socketProxyControlCommands).map((command) => command[0])).toEqual(
        owned ? [] : ["stop", "start"],
      );
    },
  );

  test("Given helper backends occupied by Traefik, When persisting, Then bind ports stay on unit hop targets", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 80, httpsPort: 443 });
    seedOwnedHelperUnits(store.files, { http: 8080, https: 8443 });
    const classifyOverride = overrideFor({
      httpFirstFree: 8000,
      httpsFirstFree: 4443,
      httpHolder: "systemd-socket-",
      httpsHolder: "systemd-socket-",
      httpUnit: "lando-proxy-http",
      httpsUnit: "lando-proxy-https",
    });
    const deps = makeDeps(store, classifyOverride, {
      globalApp: {
        ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
        ownedPublishPorts: ownedPublishPorts([8080, 8443]),
      },
      socketProxy: {
        user: "test",
        userDataRoot: USER_DATA_ROOT,
        hasHostSystemd: () => true,
        exists: (path: string) => Effect.succeed(store.files.has(path)),
        readText: (path: string) =>
          store.files.has(path) ? Effect.succeed(store.files.get(path) ?? "") : Effect.fail(new Error(path)),
        processRunner: unusedRunner,
        privilege: unusedPrivilege,
        classifyOverride,
        probeForward: () => Effect.succeed({ kind: "success" as const }),
      },
    });

    // When: persist keeps socket-helper mode.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: Traefik bind ports stay on the helper backends, not the next free pair.
    expect(decision.mode).toBe("socket-helper");
    expect(decision.httpPort).toBe(80);
    expect(readJson(store.files).bindHttpPort).toBe(8080);
    expect(readJson(store.files).bindHttpsPort).toBe(8443);
  });

  test.each(["refused", "exhausted"] as const)(
    "stops stale owned forwarding before falling back when helper repair is %s",
    async (reason) => {
      const store = memoryFiles();
      seedOwnedHelperUnits(store.files, { http: 60900, https: 60943 });
      const override = overrideFor({
        httpFirstFree: 8080,
        httpsFirstFree: 8443,
        httpHolder: "systemd-socket-",
        httpsHolder: "systemd-socket-",
        httpUnit: "lando-proxy-http",
        httpsUnit: "lando-proxy-https",
      });
      const unavailable = {
        ...override,
        httpBinds: {
          ...override.httpBinds,
          ...Object.fromEntries([38080, 48080, 58080].map((port) => [port, bind("EADDRINUSE")])),
        },
        httpsBinds: {
          ...override.httpsBinds,
          ...Object.fromEntries([38443, 48443, 58443].map((port) => [port, bind("EADDRINUSE")])),
        },
      };
      const selected = reason === "exhausted" ? unavailable : override;
      const dependencies = makeDeps(store, selected);
      const controlled: (readonly string[])[] = [];
      const elevations: (readonly string[])[] = [];
      const decision = await Effect.runPromise(
        persistPortAcquisition({
          ...dependencies,
          probeBind: () => Effect.succeed(bind("EADDRINUSE")),
          socketProxy: {
            user: "test",
            userDataRoot: USER_DATA_ROOT,
            hasHostSystemd: () => true,
            exists: (path) => Effect.succeed(store.files.has(path)),
            readText: (path) => Effect.succeed(store.files.get(path) ?? ""),
            processRunner: {
              ...unusedRunner,
              run: (input) =>
                Effect.sync(() => {
                  controlled.push(input.args);
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
            },
            privilege: {
              elevate: (command) =>
                Effect.sync(() => {
                  elevations.push(command);
                  return { exitCode: 1, stdout: "", stderr: "refused" };
                }),
            },
            classifyOverride: selected,
            probeForward: () => Effect.succeed({ kind: "failure" }),
          },
        }),
      );
      expect(decision.mode).toBe("occupied-hop");
      expect(controlled.flatMap(socketProxyControlCommands)).toEqual([
        [
          "stop",
          "lando-proxy-http.socket",
          "lando-proxy-http.service",
          "lando-proxy-https.socket",
          "lando-proxy-https.service",
        ],
      ]);
      expect(elevations).toHaveLength(reason === "refused" ? 1 : 0);
      expect(readJson(store.files).helperInstalled).toBe(true);
      expect(readJson(store.files).socketsActive).toBe(false);
    },
  );

  test("fails closed when an owned helper with foreign hops cannot be stopped", async () => {
    const store = memoryFiles();
    seedOwnedHelperUnits(store.files, { http: 60900, https: 60943 });
    const override = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "systemd-socket-",
      httpsHolder: "systemd-socket-",
      httpUnit: "lando-proxy-http",
      httpsUnit: "lando-proxy-https",
    });
    const dependencies = makeDeps(store, override);
    const elevations: (readonly string[])[] = [];
    const exit = await Effect.runPromiseExit(
      persistPortAcquisition({
        ...dependencies,
        probeBind: () => Effect.succeed(bind("EADDRINUSE")),
        socketProxy: {
          user: "test",
          userDataRoot: USER_DATA_ROOT,
          hasHostSystemd: () => true,
          exists: (path) => Effect.succeed(store.files.has(path)),
          readText: (path) => Effect.succeed(store.files.get(path) ?? ""),
          processRunner: {
            ...unusedRunner,
            run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "refused" }),
          },
          privilege: {
            elevate: (command) =>
              Effect.sync(() => {
                elevations.push(command);
                return { exitCode: 1, stdout: "", stderr: "refused" };
              }),
          },
          classifyOverride: override,
          probeForward: () => Effect.succeed({ kind: "failure" }),
        },
      }),
    );
    expect(failureTag(exit)).toBe("ProxyError");
    expect(elevations).toHaveLength(1);
    expect(elevations.flatMap(socketProxyControlCommands).map((command) => command[0])).toEqual(["stop"]);
    expect(store.files.has(acquisitionStateFile(paths))).toBe(false);
  });

  test("Given truncated systemd-socket- comm with lando-proxy units on 80/443, When persisting, Then advertised ports are 80/443", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    seedOwnedHelperUnits(store.files, { http: 8080, https: 8443 });
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "systemd-socket-",
      httpsHolder: "systemd-socket-",
      httpUnit: "lando-proxy-http",
      httpsUnit: "lando-proxy-https",
    });
    const deps = makeDeps(store, classifyOverride, {
      socketProxy: {
        user: "test",
        userDataRoot: USER_DATA_ROOT,
        hasHostSystemd: () => true,
        exists: (path: string) => Effect.succeed(store.files.has(path)),
        readText: (path: string) =>
          store.files.has(path) ? Effect.succeed(store.files.get(path) ?? "") : Effect.fail(new Error(path)),
        processRunner: unusedRunner,
        privilege: unusedPrivilege,
        classifyOverride,
        probeForward: () => Effect.succeed({ kind: "success" as const }),
      },
    });

    // When: persist sees the truncated helper comm.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: still classified as socket-helper on 80/443.
    expect(decision.mode).toBe("socket-helper");
    expect(decision.httpPort).toBe(80);
    expect(decision.httpsPort).toBe(443);
  });
});

describe("persistPortAcquisition helperOwnsPreferred", () => {
  test("Given helperInstalled and rootlessport on 80, When persisting, Then do not claim socket-helper", async () => {
    // Given: stale helperInstalled and another stack publishing 80 via rootlessport.
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const raw = store.files.get(acquisitionStateFile(paths));
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    parsed.helperInstalled = true;
    store.files.set(acquisitionStateFile(paths), `${JSON.stringify(parsed)}\n`);
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "rootlessport",
      httpsHolder: "rootlessport",
    });
    const deps = makeDeps(store, classifyOverride);
    // When
    const decision = await Effect.runPromise(persistPortAcquisition(deps));
    // Then: foreign rootlessport is occupied-hop, not our helper.
    expect(decision.mode).not.toBe("socket-helper");
  });

  test("Given stale helperInstalled without owned units, When preferred holders look like the helper, Then do not claim socket-helper", async () => {
    const store = memoryFiles();
    seedAcquisition(store.files, { httpPort: 8080, httpsPort: 8443 });
    const raw = store.files.get(acquisitionStateFile(paths));
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    parsed.helperInstalled = true;
    store.files.set(acquisitionStateFile(paths), `${JSON.stringify(parsed)}\n`);
    const classifyOverride = overrideFor({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "systemd-socket-proxyd",
      httpsHolder: "systemd-socket-proxyd",
      httpUnit: "lando-proxy-http",
      httpsUnit: "lando-proxy-https",
    });
    const deps = makeDeps(store, classifyOverride);
    const decision = await Effect.runPromise(persistPortAcquisition(deps));
    expect(decision.mode).not.toBe("socket-helper");
    expect(readJson(store.files).helperInstalled).toBe(false);
  });
});

describe("persistPortAcquisition EACCES helper install", () => {
  test("Given 80/443 EACCES and 8080 free, When installing helper, Then backends are 38080/38443", async () => {
    // Given: privileged ports fail with EACCES; 8080/8443 are free.
    const store = memoryFiles();
    const classifyOverride = {
      http: { bind: bind("EACCES"), forward: forward("failure") },
      https: { bind: bind("EACCES"), forward: forward("failure") },
      httpBinds: {
        80: bind("EACCES"),
        8080: bind("success"),
      },
      httpsBinds: {
        443: bind("EACCES"),
        8443: bind("success"),
      },
    };
    store.files.set("/usr/lib/systemd/systemd-socket-proxyd", "ok");
    const deps = makeDeps(store, classifyOverride, {
      socketProxy: {
        user: "test",
        userDataRoot: USER_DATA_ROOT,
        hasHostSystemd: () => true,
        exists: (path: string) => Effect.succeed(store.files.has(path)),
        readText: (path: string) =>
          store.files.has(path) ? Effect.succeed(store.files.get(path) ?? "") : Effect.fail(new Error(path)),
        processRunner: unusedRunner,
        privilege: unusedPrivilege,
        classifyOverride,
        probeForward: () => Effect.succeed({ kind: "success" as const }),
        autoApprove: true,
      },
    });

    // When: persist installs the socket helper.
    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    // Then: advertised 80/443, Traefik backends stay on 38080/38443 not 8080/8443.
    expect(decision.mode).toBe("socket-helper");
    expect(decision.httpPort).toBe(80);
    expect(readJson(store.files).bindHttpPort).toBe(38080);
    expect(readJson(store.files).bindHttpsPort).toBe(38443);
  });

  test.each(["other-root", "missing-root", "unattributed", "mixed"] as const)(
    "foreign helper %s falls back without host mutations",
    async (reason) => {
      const store = memoryFiles();
      const otherRoot = "/other/lando-root";
      const foreignHeader = socketProxyUnitHeader(otherRoot);
      const foreignPolkit = socketProxyPolkitHeader(otherRoot);
      for (const path of OWNED_UNIT_PATHS) {
        store.files.set(path, `${foreignHeader}\n`);
      }
      store.files.set(POLKIT_PATH, `${foreignPolkit}\n`);
      if (reason === "other-root") store.files.set(otherRoot, "dir");
      if (reason === "unattributed") {
        for (const path of OWNED_UNIT_PATHS) store.files.set(path, "# lando-proxy-socket-helper\n");
        store.files.set(POLKIT_PATH, "// lando-proxy-socket-helper\n");
      }
      if (reason === "mixed") store.files.set(OWNED_UNIT_PATHS[0], `${UNIT_HEADER}\n`);
      store.files.set("/usr/lib/systemd/systemd-socket-proxyd", "ok");
      const classifyOverride = {
        http: { bind: bind("EACCES"), forward: forward("failure") },
        https: { bind: bind("EACCES"), forward: forward("failure") },
        httpBinds: {
          80: bind("EACCES"),
          8080: bind("success"),
        },
        httpsBinds: {
          443: bind("EACCES"),
          8443: bind("success"),
        },
      };
      const mutations: string[] = [];
      const deps = makeDeps(store, classifyOverride, {
        socketProxy: {
          user: "test",
          userDataRoot: USER_DATA_ROOT,
          hasHostSystemd: () => true,
          exists: (path: string) => Effect.succeed(store.files.has(path)),
          readText: (path: string) =>
            store.files.has(path)
              ? Effect.succeed(store.files.get(path) ?? "")
              : Effect.fail(new Error(path)),
          processRunner: {
            ...unusedRunner,
            run: () =>
              Effect.sync(() => {
                mutations.push("process");
                return { exitCode: 0, stdout: "", stderr: "" };
              }),
          },
          privilege: {
            elevate: () =>
              Effect.sync(() => {
                mutations.push("elevate");
                return { exitCode: 0, stdout: "", stderr: "" };
              }),
          },
          classifyOverride,
          probeForward: () => Effect.succeed({ kind: "success" as const }),
          autoApprove: true,
        },
      });

      const decision = await Effect.runPromise(persistPortAcquisition(deps));

      expect(decision.mode).toBe("occupied-hop");
      expect(decision.notices.join(" ")).not.toContain("sudo systemctl");
      if (reason === "other-root") {
        expect(decision.notices.join(" ")).toContain(otherRoot);
      } else {
        expect(decision.notices.join(" ").length).toBeGreaterThan(0);
      }
      expect(readJson(store.files).helperInstalled).toBe(false);
      expect(mutations).toEqual([]);
    },
  );
});

describe("fresh acquisition holder labeling", () => {
  test("names an older Lando build's socket proxy as the holder when the pair is acquired fresh", async () => {
    const units = new Map<string, string>(
      SOCKET_UNIT_PATHS.map((path) => [path, "# lando-proxy-socket-helper\n[Unit]\n"]),
    );
    const base = makeDeps(
      memoryFiles(),
      overrideFor({
        httpFirstFree: 8080,
        httpsFirstFree: 8443,
        httpsHolder: "systemd-socket-",
        httpsUnit: "lando-proxy-https",
      }),
    );
    const deps: TraefikProxyDependencies = {
      ...base,
      ...(base.socketProxy === undefined
        ? {}
        : {
            socketProxy: {
              ...base.socketProxy,
              exists: (path: string) => Effect.succeed(units.has(path)),
              readText: (path: string) => {
                const text = units.get(path);
                return text === undefined ? Effect.fail(new Error(path)) : Effect.succeed(text);
              },
            },
          }),
    };

    const decision = await Effect.runPromise(persistPortAcquisition(deps));

    expect(decision.notices.join("\n")).toContain(LANDO_SOCKET_PROXY_HOLDER_LABEL);
  });
});
