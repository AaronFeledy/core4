import { describe, expect, test } from "bun:test";
import { type Context, Effect } from "effect";

import { InteractionCancelledError } from "@lando/sdk/errors";
import type {
  PrivilegeService,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";

import type { SocketProxyDependencies } from "../src/proxy-types.ts";
import { socketProxyPolkitHeader, socketProxyUnitHeader } from "../src/socket-proxy-helper.ts";
import { POLKIT_RULE_PATH, PROXYD_CANDIDATES, SOCKET_UNIT_PATHS } from "../src/socket-proxy-install.ts";
import { resolveNeedsHelper } from "../src/socket-proxy-setup.ts";

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode = 1, stderr = "denied"): ProcessResult => ({ exitCode, stdout: "", stderr });

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

const makePrivilege = (
  result: ProcessResult | ((command: ReadonlyArray<string>) => ProcessResult) = ok(),
): {
  readonly service: Context.Service.Shape<typeof PrivilegeService>;
  readonly calls: () => ReadonlyArray<ReadonlyArray<string>>;
} => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    service: {
      elevate: (command) =>
        Effect.sync(() => {
          calls.push([...command]);
          return typeof result === "function" ? result(command) : result;
        }),
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
    const privilege = makePrivilege(ok());
    const runner = makeRunner();
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "ensure",
      autoApprove: true,
    });
    expect(resolved.helperInstalled).toBe(false);
    expect(privilege.calls()).toEqual([]);
    expect(runner.calls().filter((c) => c.cmd === "systemctl")).toEqual([]);
    expect(resolved.decision.notices.join("\n")).not.toContain("sudo systemctl");
  });
});

describe("configure replacement matrix", () => {
  test("missing-root interactive default yes replaces", async () => {
    const access = hostFiles(foreignUnits(GONE));
    const privilege = makePrivilege(ok());
    const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1)));
    const confirms: string[] = [];
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "configure",
      interaction: {
        isInteractive: Effect.succeed(true),
        confirm: (spec) =>
          Effect.sync(() => {
            confirms.push(spec.name ?? "");
            return spec.default !== false;
          }),
      },
      probeForward: () => Effect.succeed({ kind: "success" }),
      probeBind: () => Effect.succeed({ kind: "success" }),
    });
    expect(confirms).toContain("replace-missing-root-socket-proxy");
    expect(privilege.calls()).toHaveLength(1);
    expect(resolved.helperInstalled).toBe(true);
    expect(resolved.decision.notices.join("\n")).toContain(GONE);
  });

  test("missing-root autoApprove replaces only when hops free", async () => {
    const access = hostFiles(foreignUnits(GONE, { http: 48080, https: 48443 }));
    const privilege = makePrivilege(ok());
    const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1)));
    const free = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "configure",
      autoApprove: true,
      probeForward: () => Effect.succeed({ kind: "success" }),
      probeBind: () => Effect.succeed({ kind: "success" }),
    });
    expect(privilege.calls()).toHaveLength(1);
    expect(free.helperInstalled).toBe(true);

    const privilege2 = makePrivilege(ok());
    const blocked = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege2.service,
      intent: "configure",
      autoApprove: true,
      probeForward: () => Effect.succeed({ kind: "success" }),
      probeBind: () => Effect.succeed({ kind: "EADDRINUSE", code: "EADDRINUSE" }),
      ownedRouterPorts: new Set(),
    });
    expect(privilege2.calls()).toEqual([]);
    expect(blocked.helperInstalled).toBe(false);
    expect(blocked.decision.notices.join("\n")).toContain("sudo");
  });

  test("missing-root autoApprove replaces when hops provider-owned", async () => {
    const access = hostFiles(foreignUnits(GONE, { http: 48080, https: 48443 }));
    const privilege = makePrivilege(ok());
    const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1)));
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "configure",
      autoApprove: true,
      probeForward: () => Effect.succeed({ kind: "success" }),
      probeBind: () => Effect.succeed({ kind: "EADDRINUSE", code: "EADDRINUSE" }),
      ownedRouterPorts: new Set([48080, 48443]),
    });
    expect(privilege.calls()).toHaveLength(1);
    expect(resolved.helperInstalled).toBe(true);
  });

  test("missing-root noninteractive/undefined interaction auto-replaces only with proven hops", async () => {
    const access = hostFiles(foreignUnits(GONE, { http: 48080, https: 48443 }));
    const privilege = makePrivilege(ok());
    const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1)));
    const free = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "configure",
      probeForward: () => Effect.succeed({ kind: "success" }),
      probeBind: () => Effect.succeed({ kind: "success" }),
    });
    expect(privilege.calls()).toHaveLength(1);
    expect(free.helperInstalled).toBe(true);
    expect(free.decision.notices.join("\n")).toContain(GONE);

    const privilege2 = makePrivilege(ok());
    const noHopsFiles = Object.fromEntries(
      SOCKET_UNIT_PATHS.map((unitPath) => [unitPath, `${socketProxyUnitHeader(GONE)}\n`]),
    );
    const blocked = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...hostFiles(noHopsFiles),
      processRunner: makeRunner().service,
      privilege: privilege2.service,
      intent: "configure",
      autoApprove: true,
      probeBind: () => Effect.succeed({ kind: "success" }),
    });
    expect(privilege2.calls()).toEqual([]);
    expect(blocked.helperInstalled).toBe(false);
    expect(blocked.decision.notices.join("\n")).toContain("sudo");
  });

  test("unattributed interactive yes replaces; no and cancel decline", async () => {
    const files = Object.fromEntries(SOCKET_UNIT_PATHS.map((p) => [p, "# lando-proxy-socket-helper\n"]));
    const access = hostFiles(files);
    for (const [answer, expectElevate] of [
      [true, true],
      [false, false],
    ] as const) {
      const privilege = makePrivilege(ok());
      const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1)));
      await runHelper({
        user: "lando-dev",
        userDataRoot: ROOT,
        hasHostSystemd: () => true,
        ...access,
        processRunner: runner.service,
        privilege: privilege.service,
        intent: "configure",
        interaction: {
          isInteractive: Effect.succeed(true),
          confirm: () => Effect.succeed(answer),
        },
        probeForward: () => Effect.succeed({ kind: "success" }),
      });
      expect(privilege.calls().length > 0).toBe(expectElevate);
    }
    const privilege = makePrivilege(ok());
    await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: makeRunner().service,
      privilege: privilege.service,
      intent: "configure",
      interaction: {
        isInteractive: Effect.succeed(true),
        confirm: () =>
          Effect.fail(
            new InteractionCancelledError({
              message: "cancel",
              remediation: "retry the prompt",
            }),
          ),
      },
    });
    expect(privilege.calls()).toEqual([]);
  });

  test("unattributed autoApprove never replaces", async () => {
    const files = Object.fromEntries(SOCKET_UNIT_PATHS.map((p) => [p, "# lando-proxy-socket-helper\n"]));
    const privilege = makePrivilege(ok());
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...hostFiles(files),
      processRunner: makeRunner().service,
      privilege: privilege.service,
      intent: "configure",
      autoApprove: true,
    });
    expect(privilege.calls()).toEqual([]);
    expect(resolved.helperInstalled).toBe(false);
    expect(resolved.decision.notices.join("\n")).toContain("sudo");
  });

  test("unattributed with undefined interaction never replaces", async () => {
    const files = Object.fromEntries(SOCKET_UNIT_PATHS.map((p) => [p, "# lando-proxy-socket-helper\n"]));
    const privilege = makePrivilege(ok());
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...hostFiles(files),
      processRunner: makeRunner().service,
      privilege: privilege.service,
      intent: "configure",
    });
    expect(privilege.calls()).toEqual([]);
    expect(resolved.helperInstalled).toBe(false);
    expect(resolved.decision.notices.join("\n")).toContain("sudo");
  });

  test("other-root never replaces even configure auto", async () => {
    const privilege = makePrivilege(ok());
    const runner = makeRunner();
    await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...hostFiles({ ...foreignUnits(OTHER), [OTHER]: "dir" }),
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "configure",
      autoApprove: true,
    });
    expect(privilege.calls()).toEqual([]);
    expect(runner.calls()).toEqual([]);
  });

  test("configure success still explains the replacement", async () => {
    const access = hostFiles(foreignUnits(GONE));
    const privilege = makePrivilege(ok());
    const runner = makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1)));
    const resolved = await runHelper({
      user: "lando-dev",
      userDataRoot: ROOT,
      hasHostSystemd: () => true,
      ...access,
      processRunner: runner.service,
      privilege: privilege.service,
      intent: "configure",
      autoApprove: true,
      probeForward: () => Effect.succeed({ kind: "success" }),
      probeBind: () => Effect.succeed({ kind: "success" }),
    });
    expect(resolved.helperInstalled).toBe(true);
    expect(resolved.decision.mode).toBe("socket-helper");
    expect(resolved.decision.notices.join("\n")).toContain(GONE);
    expect(resolved.decision.notices.join("\n")).not.toContain("sudo systemctl disable");
  });
});
