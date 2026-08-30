import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { AcquisitionState } from "../src/port-acquisition-state.ts";
import {
  type BindOutcome,
  type ClassifyAcquisitionInput,
  type ForwardOutcome,
  classifyAcquisition,
  probeBind,
} from "../src/port-acquisition.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "../src/ports.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import { makeTraefikProxyService } from "../src/proxy.ts";

const LOOPBACK = "127.0.0.1" as const;
const HTTP_TRY_LIST = [80, 8080, 8000, 8888, 8008, 38080] as const;
const HTTPS_TRY_LIST = [443, 8443, 4443, 4433, 4444, 444, 38443] as const;

const bind = (kind: BindOutcome["kind"], code?: string): BindOutcome => {
  switch (kind) {
    case "success":
      return { kind: "success" };
    case "EADDRINUSE":
      return { kind: "EADDRINUSE", code: "EADDRINUSE" };
    case "EACCES":
      return { kind: "EACCES", code: code === "EPERM" ? "EPERM" : "EACCES" };
    case "other-error":
      return { kind: "other-error", ...(code === undefined ? {} : { code }) };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unexpected bind kind: ${String(exhaustive)}`);
    }
  }
};

const forward = (kind: ForwardOutcome["kind"]): ForwardOutcome => ({ kind });

const portBinds = (
  list: readonly number[],
  firstFree: number,
  occupiedKind: BindOutcome["kind"] = "EADDRINUSE",
): Readonly<Record<number, BindOutcome>> => {
  const binds: Record<number, BindOutcome> = {};
  let seenFree = false;
  for (const port of list) {
    if (!seenFree && port === firstFree) {
      binds[port] = bind("success");
      seenFree = true;
      continue;
    }
    binds[port] = seenFree ? bind("success") : bind(occupiedKind);
  }
  return binds;
};

type TryListClassifyInput = ClassifyAcquisitionInput & {
  readonly httpBinds: Readonly<Record<number, BindOutcome>>;
  readonly httpsBinds: Readonly<Record<number, BindOutcome>>;
  readonly httpTryList: readonly number[];
  readonly httpsTryList: readonly number[];
  readonly bindAddress: string;
};

const tryListInput = (fields: {
  readonly platform?: ClassifyAcquisitionInput["platform"];
  readonly httpFirstFree: number;
  readonly httpsFirstFree: number;
  readonly httpOccupiedKind?: BindOutcome["kind"];
  readonly httpsOccupiedKind?: BindOutcome["kind"];
  readonly httpHolder?: string;
  readonly httpsHolder?: string;
  readonly httpForward?: ForwardOutcome;
  readonly httpsForward?: ForwardOutcome;
}): TryListClassifyInput => {
  const httpBinds = portBinds(HTTP_TRY_LIST, fields.httpFirstFree, fields.httpOccupiedKind);
  const httpsBinds = portBinds(HTTPS_TRY_LIST, fields.httpsFirstFree, fields.httpsOccupiedKind);
  const httpBind = httpBinds[80] ?? bind("EADDRINUSE");
  const httpsBind = httpsBinds[443] ?? bind("EADDRINUSE");
  return {
    platform: fields.platform ?? "linux",
    helperInstalled: false,
    socketsActive: false,
    http: {
      bind: httpBind,
      forward: fields.httpForward ?? forward("failure"),
      ...(fields.httpHolder === undefined ? {} : { holder: fields.httpHolder }),
    },
    https: {
      bind: httpsBind,
      forward: fields.httpsForward ?? forward("failure"),
      ...(fields.httpsHolder === undefined ? {} : { holder: fields.httpsHolder }),
    },
    httpBinds,
    httpsBinds,
    httpTryList: HTTP_TRY_LIST,
    httpsTryList: HTTPS_TRY_LIST,
    bindAddress: LOOPBACK,
  };
};

describe("classifyAcquisition", () => {
  test("Given 80,8080,8000 occupied, When 8888 TCP-binds, Then HTTP try order reaches 8888 before 38080", () => {
    // Given: HTTP try list 80,8080,8000,8888,8008,38080 with first free at 8888.
    const input = tryListInput({ httpFirstFree: 8888, httpsFirstFree: 443 });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: 8888 wins; 38080 is last-resort, not the hop target.
    expect(input.httpTryList).toEqual([80, 8080, 8000, 8888, 8008, 38080]);
    expect(decision.httpPort).toBe(8888);
    expect(decision.httpPort).not.toBe(TRAEFIK_HTTP_PORT);
  });

  test("Given 443,8443 occupied, When 4443 TCP-binds, Then HTTPS try order reaches 4443 before 38443", () => {
    // Given: HTTPS try list 443,8443,4443,4433,4444,444,38443 with first free at 4443.
    const input = tryListInput({ httpFirstFree: 80, httpsFirstFree: 4443 });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: 4443 wins; 38443 is last-resort, not the hop target.
    expect(input.httpsTryList).toEqual([443, 8443, 4443, 4433, 4444, 444, 38443]);
    expect(decision.httpsPort).toBe(4443);
    expect(decision.httpsPort).not.toBe(TRAEFIK_HTTPS_PORT);
  });

  test("Given 80 and 443 TCP-bind success, When classifying, Then first success wins on preferred ports", () => {
    // Given: every try-list port can bind; 80 and 443 are first.
    const input = tryListInput({ httpFirstFree: 80, httpsFirstFree: 443 });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: first TCP-bind success per protocol is the preferred pair.
    expect(decision.mode).not.toBe("degraded-high-ports");
    expect(decision.httpPort).toBe(80);
    expect(decision.httpsPort).toBe(443);
  });

  test("Given 80 occupied and 8080 free, When classifying, Then first TCP-bind success is 8080", () => {
    // Given: HTTP 80 is EADDRINUSE; 8080 and later can bind. Later frees must not win.
    const input = tryListInput({
      httpFirstFree: 8080,
      httpsFirstFree: 443,
      httpHolder: "nginx",
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: 8080 is first HTTP success, not 8000 or 38080.
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpPort).not.toBe(TRAEFIK_HTTP_PORT);
  });

  test("Given 443 occupied and 8443 free, When classifying, Then first TCP-bind success is 8443", () => {
    // Given: HTTPS 443 is EADDRINUSE; 8443 and later can bind.
    const input = tryListInput({
      httpFirstFree: 80,
      httpsFirstFree: 8443,
      httpsHolder: "nginx",
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: 8443 is first HTTPS success, not 38443.
    expect(decision.httpsPort).toBe(8443);
    expect(decision.httpsPort).not.toBe(TRAEFIK_HTTPS_PORT);
  });

  test("Given preferred occupied and a fallback chosen, When classifying, Then mode is occupied-hop", () => {
    // Given: 80/443 held by nginx; 8080/8443 bind successfully.
    const input = tryListInput({
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpHolder: "nginx",
      httpsHolder: "nginx",
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: fallback is occupied-hop, not a silent high-port degrade.
    expect(decision.mode).toBe("occupied-hop");
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
  });

  test("Given darwin cannot bind 80, When 8080 TCP-binds, Then try-list fallback is chosen", () => {
    // Given: darwin, preferred ports fail with other-error, 8080/8443 are free.
    const input = tryListInput({
      platform: "darwin",
      httpFirstFree: 8080,
      httpsFirstFree: 8443,
      httpOccupiedKind: "other-error",
      httpsOccupiedKind: "other-error",
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: walk the try list; do not snap to degraded-high-ports 38080/38443.
    expect(decision.mode).not.toBe("degraded-high-ports");
    expect(decision.httpPort).toBe(8080);
    expect(decision.httpsPort).toBe(8443);
  });

  test("Given 80 EADDRINUSE and HTTP GET failure, When 8080 TCP-binds, Then freeness is probeBind not GET", () => {
    // Given: 80 is occupied at TCP; HTTP GET/forward would report failure (not a proxy).
    const input = tryListInput({
      httpFirstFree: 8080,
      httpsFirstFree: 443,
      httpHolder: "sshd",
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
    });

    // When: classification walks per-port BindOutcome from probeBind/TCP.
    const decision = classifyAcquisition(input);

    // Then: GET failure does not mark 80 free; first TCP-bind success is 8080.
    expect(input.httpBinds[80]?.kind).toBe("EADDRINUSE");
    expect(input.http.forward.kind).toBe("failure");
    expect(decision.httpPort).toBe(8080);
  });
});

describe("probeBind", () => {
  test("classifies success when an ephemeral loopback port can be bound", async () => {
    // Given: 127.0.0.1 and an ephemeral port.
    // When: probeBind listens and immediately closes.
    const outcome = await Effect.runPromise(probeBind(LOOPBACK, 0));

    // Then: the real bind is classified as success.
    expect(outcome.kind).toBe("success");
  });

  test("Given probeBind, When checking freeness, Then the outcome is a TCP listen not an HTTP GET", async () => {
    // Given: an ephemeral loopback port with no HTTP server.
    // When: probeBind performs a listen/close.
    const outcome = await Effect.runPromise(probeBind(LOOPBACK, 0));

    // Then: freeness is BindOutcome success from TCP bind, not an HTTP GET scan.
    expect(outcome.kind).toBe("success");
    expect("statusCode" in outcome).toBe(false);
  });
});

describe("acquisitionStateFile", () => {
  test("places plugin-private JSON next to the dynamic routing state", () => {
    // Given: a linux global-app root.
    const paths = { platform: "linux" as const, globalAppRoot: "/lando/global" };

    // When: the acquisition state path is derived.
    const path = acquisitionStateFile(paths);

    // Then: it sits beside the other proxy-traefik dynamic state files.
    expect(path).toBe("/lando/global/proxy-traefik/dynamic/.lando-port-acquisition.json");
  });
});

describe("setup persistence", () => {
  test("persists classified acquisition mode after the service is running", async () => {
    // Given: a Traefik proxy whose global service ensureRunning succeeds.
    const files = new Map<string, string>();
    const service = makeTraefikProxyService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: {
        mkdir: () => Effect.void,
        writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        remove: (path) => Effect.sync(() => void files.delete(path)),
        exists: (path) => Effect.succeed(files.has(path)),
        readDir: () => Effect.succeed([]),
        readText: (path) =>
          files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
      },
      paths: { platform: "linux", globalAppRoot: "/lando/global" },
      globalApp: {
        ensureRunning: () =>
          Effect.succeed([{ name: "traefik", state: "running", endpoints: ["http://127.0.0.1:38080"] }]),
      },
    });
    const statePath = acquisitionStateFile({ platform: "linux", globalAppRoot: "/lando/global" });

    // When: setup runs after the service is ensured running.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: plugin-private JSON records a classified mode and effective ports.
    const raw = files.get(statePath);
    expect(raw).toBeDefined();
    const decoded = Schema.decodeUnknownSync(AcquisitionState)(JSON.parse(raw ?? "null"));
    const httpPorts: readonly number[] = HTTP_TRY_LIST;
    const httpsPorts: readonly number[] = HTTPS_TRY_LIST;
    expect(httpPorts.includes(decoded.httpPort)).toBe(true);
    expect(httpsPorts.includes(decoded.httpsPort)).toBe(true);
  });
});
