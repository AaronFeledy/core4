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

const linuxInput = (
  fields: Partial<ClassifyAcquisitionInput> & {
    readonly httpBind: BindOutcome;
    readonly httpsBind: BindOutcome;
    readonly httpForward: ForwardOutcome;
    readonly httpsForward: ForwardOutcome;
  },
): ClassifyAcquisitionInput => ({
  platform: "linux",
  helperInstalled: false,
  socketsActive: false,
  http: {
    bind: fields.httpBind,
    forward: fields.httpForward,
    ...(fields.http?.holder === undefined ? {} : { holder: fields.http.holder }),
  },
  https: {
    bind: fields.httpsBind,
    forward: fields.httpsForward,
    ...(fields.https?.holder === undefined ? {} : { holder: fields.https.holder }),
  },
  ...("platform" in fields ? { platform: fields.platform } : {}),
  ...("helperInstalled" in fields ? { helperInstalled: fields.helperInstalled } : {}),
  ...("socketsActive" in fields ? { socketsActive: fields.socketsActive } : {}),
});

describe("classifyAcquisition", () => {
  test("selects direct when the desired low ports already serve a healthy proxy", () => {
    // Given: loopback 80/443 already answer as a healthy proxy.
    const input = linuxInput({
      httpBind: bind("EADDRINUSE"),
      httpsBind: bind("EADDRINUSE"),
      httpForward: forward("success"),
      httpsForward: forward("success"),
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: mode is direct and authorities stay on privileged ports.
    expect(decision.mode).toBe("direct");
    expect(decision.httpPort).toBe(80);
    expect(decision.httpsPort).toBe(443);
  });

  test("selects occupied-hop when bind is EADDRINUSE by a foreign holder", () => {
    // Given: a foreign process holds 80/443 and is not our Traefik.
    const input = linuxInput({
      httpBind: bind("EADDRINUSE"),
      httpsBind: bind("EADDRINUSE"),
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
      http: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
      https: { bind: bind("EADDRINUSE"), forward: forward("failure"), holder: "nginx" },
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: authority stays on high ports and the notice names the holder.
    expect(decision.mode).toBe("occupied-hop");
    expect(decision.httpPort).toBe(TRAEFIK_HTTP_PORT);
    expect(decision.httpsPort).toBe(TRAEFIK_HTTPS_PORT);
    expect(decision.notices.some((notice) => notice.includes("nginx"))).toBe(true);
  });

  test("does not treat a foreign HTTP listener as a direct Lando proxy", () => {
    // Given: 80/443 answer HTTP but the holder is nginx, not our forwarder.
    const input = linuxInput({
      httpBind: bind("EADDRINUSE"),
      httpsBind: bind("EADDRINUSE"),
      httpForward: forward("success"),
      httpsForward: forward("success"),
      http: { bind: bind("EADDRINUSE"), forward: forward("success"), holder: "nginx" },
      https: { bind: bind("EADDRINUSE"), forward: forward("success"), holder: "nginx" },
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: stay on high ports and name the foreign holder.
    expect(decision.mode).toBe("occupied-hop");
    expect(decision.httpPort).toBe(TRAEFIK_HTTP_PORT);
    expect(decision.httpsPort).toBe(TRAEFIK_HTTPS_PORT);
    expect(decision.notices.some((notice) => notice.includes("nginx"))).toBe(true);
  });

  test("does not advertise privileged ports just because bind succeeds", () => {
    // Given: 80/443 are free (we can bind them) but nothing is forwarding yet.
    const input = linuxInput({
      httpBind: bind("success"),
      httpsBind: bind("success"),
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: do not publish :80/:443 authorities on an unused port.
    expect(decision.mode).toBe("needs-helper");
    expect(decision.httpPort).toBe(TRAEFIK_HTTP_PORT);
    expect(decision.httpsPort).toBe(TRAEFIK_HTTPS_PORT);
  });

  test("selects needs-helper when bind is EACCES and the helper is not installed", () => {
    // Given: Linux rootless EACCES and no socket helper on disk.
    const input = linuxInput({
      httpBind: bind("EACCES"),
      httpsBind: bind("EACCES"),
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
      helperInstalled: false,
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: mode asks for helper install and effective ports stay high.
    expect(decision.mode).toBe("needs-helper");
    expect(decision.httpPort).toBe(TRAEFIK_HTTP_PORT);
    expect(decision.httpsPort).toBe(TRAEFIK_HTTPS_PORT);
  });

  test("selects socket-helper when the helper is installed but sockets are inactive", () => {
    // Given: helper state says installed, sockets are not listening yet.
    const input = linuxInput({
      httpBind: bind("EACCES"),
      httpsBind: bind("EACCES"),
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
      helperInstalled: true,
      socketsActive: false,
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: later phase should start sockets on privileged ports.
    expect(decision.mode).toBe("socket-helper");
    expect(decision.httpPort).toBe(80);
    expect(decision.httpsPort).toBe(443);
  });

  test("does not treat stale socketsActive as proof sockets are up", () => {
    // Given: units exist and JSON still says sockets are active, but forwards fail with EACCES.
    const input = linuxInput({
      httpBind: bind("EACCES"),
      httpsBind: bind("EACCES"),
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
      helperInstalled: true,
      socketsActive: true,
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: do not degrade — later phase must restart the helper.
    expect(decision.mode === "needs-helper" || decision.mode === "socket-helper").toBe(true);
    expect(decision.mode).not.toBe("degraded-high-ports");
  });

  test("selects degraded-high-ports when non-Linux cannot acquire privileged ports", () => {
    // Given: darwin, no healthy proxy, bind refused / other-error, no NAT helper.
    const input = linuxInput({
      platform: "darwin",
      httpBind: bind("other-error", "ECONNREFUSED"),
      httpsBind: bind("other-error", "ECONNREFUSED"),
      httpForward: forward("failure"),
      httpsForward: forward("failure"),
    });

    // When: classification runs.
    const decision = classifyAcquisition(input);

    // Then: fall back to the high-port authorities.
    expect(decision.mode).toBe("degraded-high-ports");
    expect(decision.httpPort).toBe(TRAEFIK_HTTP_PORT);
    expect(decision.httpsPort).toBe(TRAEFIK_HTTPS_PORT);
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
    expect(decoded.httpPort === 80 || decoded.httpPort === TRAEFIK_HTTP_PORT).toBe(true);
    expect(decoded.httpsPort === 443 || decoded.httpsPort === TRAEFIK_HTTPS_PORT).toBe(true);
  });
});
