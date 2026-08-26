import { describe, expect, test } from "bun:test";
import { type Context, Effect, Schema } from "effect";

import { AppId, ServiceName } from "@lando/sdk/schema";
import type {
  PrivilegeService,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { AcquisitionState } from "../src/port-acquisition-state.ts";
import { acquisitionStateFile, routingStateFile } from "../src/proxy-paths.ts";
import { makeTraefikProxyService } from "../src/proxy.ts";
import { PROXYD_CANDIDATES, SOCKET_UNIT_PATHS } from "../src/socket-proxy-install.ts";

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode = 1, stderr = "denied"): ProcessResult => ({ exitCode, stdout: "", stderr });

type RunCall = {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
};

const makeRunner = (
  handler: (input: ProcessSpawnOptions) => ProcessResult = () => ok(),
): {
  readonly service: Context.Tag.Service<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<RunCall>;
} => {
  const calls: RunCall[] = [];
  return {
    service: {
      run: (input) =>
        Effect.sync(() => {
          calls.push({ cmd: input.cmd, args: [...input.args] });
          return handler(input);
        }),
      stream: () => {
        throw new Error("stream is unused");
      },
    },
    calls: () => [...calls],
  };
};

const makePrivilege = (
  result: ProcessResult = ok(),
): {
  readonly service: Context.Tag.Service<typeof PrivilegeService>;
  readonly calls: () => ReadonlyArray<ReadonlyArray<string>>;
} => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    service: {
      elevate: (command) =>
        Effect.sync(() => {
          calls.push([...command]);
          return result;
        }),
    },
    calls: () => [...calls],
  };
};

const app = AppId.make("demo");
const routes = [
  {
    hostname: "web.demo.lndo.site",
    scheme: "http" as const,
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 8088 },
  },
];

const paths = { platform: "linux" as const, globalAppRoot: "/lando/global" };
const markedUnit = "[Unit]\n# lando-proxy-socket-helper\n";

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

describe("acquisition authority ports", () => {
  test("status authorities use 80/443 after setup in mocked-direct mode", async () => {
    // Given: classification is forced to a successful privileged bind.
    const store = memoryFiles();
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
      socketProxy: {
        user: "lando-dev",
        hasHostSystemd: () => false,
        exists: () => Effect.succeed(false),
        readText: () => Effect.fail(new Error("missing")),
        processRunner: makeRunner().service,
        privilege: makePrivilege().service,
        classifyOverride: {
          http: { bind: { kind: "success" }, forward: { kind: "failure" } },
          https: { bind: { kind: "success" }, forward: { kind: "failure" } },
        },
      },
    });

    // When: setup persists acquisition and routes are applied.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(service.applyRoutes(routes, app));
    const status = await Effect.runPromise(service.status);
    const routing = store.files.get(routingStateFile(paths)) ?? "";

    // Then: live and persisted authorities follow the decision ports, not Traefik 38443.
    expect(status.authorities.map(({ port }) => port)).toEqual([80]);
    expect(routing).toContain(":80");
    expect(routing).toContain(":443");
    expect(routing).not.toContain(":38443");
  });

  test("status authorities use 80/443 after setup in socket-helper mode", async () => {
    // Given: EACCES on 80/443, proxyd present, elevate and forward succeed.
    const store = memoryFiles();
    const first = PROXYD_CANDIDATES[0] ?? "/usr/lib/systemd/systemd-socket-proxyd";
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
      socketProxy: {
        user: "lando-dev",
        hasHostSystemd: () => true,
        autoApprove: true,
        exists: (path) => Effect.succeed(path === first),
        readText: () => Effect.fail(new Error("missing")),
        processRunner: makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1, "not found")))
          .service,
        privilege: makePrivilege().service,
        classifyOverride: {
          http: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
          https: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
        },
        probeForward: () => Effect.succeed({ kind: "success" }),
      },
    });

    // When: setup installs the helper and routes are applied.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(service.applyRoutes(routes, app));
    const status = await Effect.runPromise(service.status);

    // Then: authorities advertise 80/443, not Traefik's published 38443.
    expect(status.authorities.map(({ port }) => port)).toEqual([80]);
  });
});

describe("stale socketsActive restart", () => {
  test("starts sockets when persisted socketsActive is stale and forwards fail", async () => {
    // Given: helperInstalled and socketsActive are true in JSON, units exist, but forwards fail.
    const store = memoryFiles();
    store.files.set(
      acquisitionStateFile(paths),
      `${JSON.stringify({
        mode: "socket-helper",
        httpPort: 80,
        httpsPort: 443,
        notices: [],
        helperInstalled: true,
        socketsActive: true,
      })}\n`,
    );
    for (const path of SOCKET_UNIT_PATHS) {
      store.files.set(path, markedUnit);
    }
    const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1, "not found")));
    const privilege = makePrivilege();
    const first = PROXYD_CANDIDATES[0] ?? "/usr/lib/systemd/systemd-socket-proxyd";
    const service = makeTraefikProxyService({
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: store.fileSystem,
      paths,
      globalApp: {
        ensureRunning: () =>
          Effect.succeed([{ name: "traefik", state: "running", endpoints: ["http://127.0.0.1:38080"] }]),
      },
      socketProxy: {
        user: "lando-dev",
        hasHostSystemd: () => true,
        autoApprove: true,
        exists: (path) => Effect.succeed(store.files.has(path) || path === first),
        readText: (path) =>
          store.files.has(path) ? Effect.succeed(store.files.get(path) ?? "") : Effect.fail(new Error(path)),
        processRunner: runner.service,
        privilege: privilege.service,
        classifyOverride: {
          http: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
          https: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
        },
        probeForward: () => Effect.succeed({ kind: "success" }),
      },
    });

    // When: setup re-classifies the stale helper state.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: startSockets ran and persisted mode is socket-helper.
    const started =
      runner.calls().some((call) => call.cmd === "systemctl" && call.args[0] === "start") ||
      privilege.calls().some((command) => command.includes("start"));
    expect(started).toBe(true);
    const raw = store.files.get(acquisitionStateFile(paths));
    const decoded = Schema.decodeUnknownSync(AcquisitionState)(JSON.parse(raw ?? "null"));
    expect(decoded.mode).toBe("socket-helper");
    expect(decoded.httpPort).toBe(80);
    expect(decoded.httpsPort).toBe(443);
  });
});
