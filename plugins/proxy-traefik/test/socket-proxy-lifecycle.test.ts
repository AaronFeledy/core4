import { describe, expect, test } from "bun:test";
import { type Context, Effect } from "effect";

import type {
  PrivilegeService,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";

import { defaultAcquisitionFingerprint } from "../src/port-acquisition.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import type { SocketProxyDependencies } from "../src/proxy-types.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

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

const makeLifecycleHarness = (input: {
  readonly mode: "socket-helper" | "occupied-hop";
  readonly helperInstalled: boolean;
}) => {
  const files = new Map<string, string>();
  const runner = makeRunner();
  const privilege = makePrivilege();
  const paths = { platform: "linux" as const, globalAppRoot: "/lando/global" };
  files.set(
    acquisitionStateFile(paths),
    `${JSON.stringify({
      mode: input.mode,
      httpPort: input.mode === "socket-helper" ? 80 : 8080,
      httpsPort: input.mode === "socket-helper" ? 443 : 8443,
      notices: [],
      fingerprint: defaultAcquisitionFingerprint(),
      helperInstalled: input.helperInstalled,
      socketsActive: input.mode === "socket-helper",
    })}\n`,
  );
  const socketProxy: SocketProxyDependencies = {
    user: "lando-dev",
    hasHostSystemd: () => true,
    exists: (path) => Effect.succeed(files.has(path)),
    readText: (path) =>
      files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
    processRunner: runner.service,
    privilege: privilege.service,
    probeForward: () => Effect.succeed({ kind: "success" }),
  };
  const service = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
      exists: (path) =>
        Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
      readDir: (path) =>
        Effect.succeed(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1)),
        ),
      readText: (path) =>
        files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
    },
    paths,
    globalApp: {
      ensureRunning: () => Effect.succeed([{ name: "traefik", state: "running", endpoints: [] }]),
    },
    socketProxy,
  });
  return { service, runner, privilege, files, paths };
};

const stopInvocations = (
  runner: ReturnType<typeof makeRunner>,
  privilege: ReturnType<typeof makePrivilege>,
) =>
  [
    ...runner.calls().filter((call) => call.cmd === "systemctl" && call.args[0] === "stop"),
    ...privilege.calls().filter((command) => command[0] === "systemctl" && command[1] === "stop"),
  ] as const;

describe("socket proxy lifecycle stop", () => {
  test("stop clears sockets only in socket-helper mode when the helper is installed", async () => {
    // Given: persisted acquisition is socket-helper with units installed.
    const harness = makeLifecycleHarness({ mode: "socket-helper", helperInstalled: true });

    // When: the global proxy stops.
    await Effect.runPromise(harness.service.stop);

    // Then: systemctl stop is issued for the helper sockets and acquisition state is cleared.
    expect(stopInvocations(harness.runner, harness.privilege).length).toBeGreaterThan(0);
    expect(harness.files.has(acquisitionStateFile(harness.paths))).toBe(false);
  });

  test("stop leaves sockets running when acquisition is not socket-helper", async () => {
    // Given: persisted acquisition is occupied-hop even if units exist.
    const harness = makeLifecycleHarness({ mode: "occupied-hop", helperInstalled: true });

    // When: the global proxy stops.
    await Effect.runPromise(harness.service.stop);

    // Then: no socket stop is issued.
    expect(stopInvocations(harness.runner, harness.privilege)).toEqual([]);
  });
});
