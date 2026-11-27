import { describe, expect, test } from "bun:test";
import type { ProcessResult, ProcessRunner, ProcessSpawnOptions } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import type { SocketProxyDependencies } from "../src/proxy-types.ts";
import { socketProxyPolkitHeader, socketProxyUnitHeader } from "../src/socket-proxy-helper.ts";
import { POLKIT_RULE_PATH, PROXYD_CANDIDATES, SOCKET_UNIT_PATHS } from "../src/socket-proxy-install.ts";
import { resolveNeedsHelper } from "../src/socket-proxy-setup.ts";

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

const makeRunner = (
  handler: (input: ProcessSpawnOptions) => ProcessResult = () => ok(),
): {
  readonly service: Context.Service.Shape<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<{ cmd: string; args: ReadonlyArray<string> }>;
} => {
  const calls: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
  return {
    service: {
      run: (input) =>
        Effect.sync(() => {
          calls.push({ cmd: input.cmd, args: [...input.args] });
          return handler(input);
        }),
      stream: () => {
        throw new Error("unused");
      },
      streamWithExit: () => {
        throw new Error("unused");
      },
    },
    calls: () => [...calls],
  };
};

const [packagedProxyd] = PROXYD_CANDIDATES;
const ROOT = "/lando";
const OTHER = "/lando/other";
const GONE = "/lando/gone";

const hostFiles = (present: Readonly<Record<string, string>> = {}) => {
  const files = new Map(Object.entries(present));
  return {
    exists: (path: string) => Effect.succeed(files.has(path) || path === packagedProxyd),
    readText: (path: string) =>
      files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
  };
};

const foreignUnits = (owner: string, hopPorts = { http: 48080, https: 48443 }) => {
  const header = socketProxyUnitHeader(owner);
  return {
    ...Object.fromEntries(
      SOCKET_UNIT_PATHS.map((path) => {
        if (path.endsWith("http.service")) {
          return [
            path,
            `${header}\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:${hopPorts.http}\n`,
          ];
        }
        if (path.endsWith("https.service")) {
          return [
            path,
            `${header}\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:${hopPorts.https}\n`,
          ];
        }
        return [path, `${header}\n`];
      }),
    ),
    [POLKIT_RULE_PATH]: socketProxyPolkitHeader(owner),
  };
};

const hops = { httpTarget: 38080, httpsTarget: 38443 };

const runHelper = (deps: SocketProxyDependencies) =>
  Effect.runPromise(Effect.scoped(resolveNeedsHelper(deps, hops)));

describe("ensure intent never touches foreign helpers", () => {
  test.each([
    { name: "other-root", files: { ...foreignUnits(OTHER), [OTHER]: "dir" } },
    { name: "missing-root", files: foreignUnits(GONE) },
    {
      name: "unattributed",
      files: Object.fromEntries(SOCKET_UNIT_PATHS.map((p) => [p, "# lando-proxy-socket-helper"])),
    },
    {
      name: "mixed",
      files: {
        [SOCKET_UNIT_PATHS[0]]: "user",
        ...Object.fromEntries(SOCKET_UNIT_PATHS.slice(1).map((p) => [p, socketProxyUnitHeader(ROOT)])),
      },
    },
    { name: "unmarked", files: Object.fromEntries(SOCKET_UNIT_PATHS.map((p) => [p, "[Unit]\n"])) },
  ])("$name: zero privilege and systemctl calls", async ({ files }) => {
    const access = hostFiles(files);
    const runner = makeRunner();
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      intent: "ensure",
    });
    expect(resolved.helperInstalled).toBe(false);
    expect(runner.calls().filter((c) => c.cmd === "systemctl")).toEqual([]);
    expect(resolved.decision.notices.join("\n")).not.toContain("sudo systemctl");
  });
});
