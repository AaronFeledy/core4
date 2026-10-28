import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { DateTime, Effect, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec, ExecTarget } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { exec } from "../src/podman/exec-transport.ts";
import {
  EXEC_UMASK_COMPENSATION,
  EXEC_UMASK_PROBE_COMMAND,
  EXEC_UMASK_SHELL_PROBE_COMMAND,
  EXEC_UMASK_WRAPPER_ARGV0,
  EXEC_UMASK_WRAPPER_SCRIPT,
  EXEC_UMASK_WRAPPER_SHELL,
  WORLD_WRITABLE_UMASK,
  isMissingShellExit,
  isShellProbeCommand,
  isUmaskProbeCommand,
  isWorldWritableUmask,
  isWrappedExecCommand,
  parseProcSelfStatusUmask,
  peekContainerHasShell,
  peekExecUmask,
  rememberContainerHasShell,
  rememberExecUmask,
  shellProbeOutcome,
  wrapExecCommand,
} from "../src/podman/exec-umask.ts";

const ctx = { providerId: "docker", remediation: "Run `lando setup` and retry.", env: {} } as const;
const providerId = ProviderId.make("docker");
const appId = AppId.make("exec-umask-app");
const serviceName = ServiceName.make("web");
const otherService = ServiceName.make("db");
const containerName = "lando-exec-umask-app-web";
const otherContainer = "lando-exec-umask-app-db";
const createPath = `/containers/${containerName}/exec` as const;
const otherCreatePath = `/containers/${otherContainer}/exec` as const;
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-20T00:00:00Z"),
  source: "container-runtime/exec-umask.test.ts",
  runtime: 4 as const,
};

const makeService = (name: ServiceName): ServicePlan => ({
  name,
  type: "node",
  provider: providerId,
  primary: name === serviceName,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const plan: AppPlan = {
  id: appId,
  name: "Exec Umask App",
  slug: "exec-umask-app",
  root: AbsolutePath.make("/tmp/exec-umask-app"),
  provider: providerId,
  services: { [serviceName]: makeService(serviceName), [otherService]: makeService(otherService) },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const target = { app: appId, service: serviceName };
const attachFrame = (kind: 1 | 2, value: string): Uint8Array => {
  const payload = new TextEncoder().encode(value);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
};

const commandOf = (body: unknown): ReadonlyArray<string> | undefined => {
  if (typeof body !== "object" || body === null || !("Cmd" in body)) return undefined;
  const cmd = (body as { Cmd?: unknown }).Cmd;
  return Array.isArray(cmd) ? cmd.map(String) : undefined;
};

const createBodies = (calls: ReadonlyArray<EngineHttpRequest>): ReadonlyArray<ReadonlyArray<string>> =>
  calls
    .filter((call) => call.method === "POST" && call.path.endsWith("/exec"))
    .map((call) => commandOf(call.body))
    .filter((cmd): cmd is ReadonlyArray<string> => cmd !== undefined);

interface FakeExecScript {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

const containerNameOf = (path: string): string | undefined => {
  const execMatch = /^\/containers\/([^/]+)\/exec$/u.exec(path);
  if (execMatch?.[1] !== undefined) return decodeURIComponent(execMatch[1]);
  const inspectMatch = /^\/containers\/([^/]+)\/json$/u.exec(path);
  return inspectMatch?.[1] === undefined ? undefined : decodeURIComponent(inspectMatch[1]);
};

const makeScriptedApi = (
  scriptFor: (cmd: ReadonlyArray<string>, container: string, user?: string) => FakeExecScript,
  options: {
    readonly failCreate?: (cmd: ReadonlyArray<string>, container: string, user?: string) => boolean;
    readonly containerId?: (container: string) => string;
  } = {},
) => {
  const calls: EngineHttpRequest[] = [];
  let nextId = 1;
  const scripts = new Map<string, FakeExecScript>();
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(input);
        if (input.method === "GET" && input.path.startsWith("/containers/") && input.path.endsWith("/json")) {
          const name = containerNameOf(input.path) ?? "unknown";
          return {
            status: 200,
            body: JSON.stringify({
              Id: options.containerId?.(name) ?? `cid-${name}`,
              State: { Running: true },
            }),
          };
        }
        if (input.method === "POST" && input.path.endsWith("/exec")) {
          const container = containerNameOf(input.path) ?? "unknown";
          const cmd = commandOf(input.body) ?? [];
          const body = input.body;
          const user =
            typeof body === "object" && body !== null && "User" in body && typeof body.User === "string"
              ? body.User
              : undefined;
          if (options.failCreate?.(cmd, container, user) === true) {
            return { status: 500, body: "exec create failed" };
          }
          const id = `exec-${nextId}`;
          nextId += 1;
          scripts.set(id, scriptFor(cmd, container, user));
          return { status: 201, body: JSON.stringify({ Id: id }) };
        }
        if (input.method === "GET" && input.path.startsWith("/exec/") && input.path.endsWith("/json")) {
          const id = decodeURIComponent(input.path.slice("/exec/".length, -"/json".length));
          return { status: 200, body: JSON.stringify({ ExitCode: scripts.get(id)?.exitCode ?? 0 }) };
        }
        return { status: 500, body: `unexpected ${input.method} ${input.path}` };
      }),
    stream: (input) => {
      calls.push(input);
      const match = /^\/exec\/([^/]+)\/start$/u.exec(input.path);
      const script = match?.[1] === undefined ? undefined : scripts.get(match[1]);
      const chunks: Uint8Array[] = [];
      if (script?.stdout !== undefined && script.stdout.length > 0) {
        chunks.push(attachFrame(1, script.stdout));
      }
      if (script?.stderr !== undefined && script.stderr.length > 0) {
        chunks.push(attachFrame(2, script.stderr));
      }
      return Stream.fromIterable(chunks);
    },
  };
  return { api, calls, createPath, otherCreatePath };
};

const runExec = (
  api: EngineHttpApi,
  command: CommandSpec,
  execTarget: ExecTarget = target,
  onWarn?: (message: string) => void,
) =>
  Effect.runPromise(
    exec(plan, execTarget, command, { api, ctx, ...(onWarn === undefined ? {} : { onWarn }) }),
  );

const umaskStatus = (umask: string): string =>
  `Name:\tcat\nState:\tS (sleeping)\nUmask:\t${umask}\nPid:\t1\n`;

describe("parseProcSelfStatusUmask", () => {
  test("reads a tab-separated four-digit umask", () => {
    expect(parseProcSelfStatusUmask(umaskStatus("0000"))).toBe("0000");
    expect(parseProcSelfStatusUmask(umaskStatus("0022"))).toBe("0022");
  });

  test("pads a three-digit umask and ignores missing lines", () => {
    expect(parseProcSelfStatusUmask("Umask: 022\n")).toBe("0022");
    expect(parseProcSelfStatusUmask("Name:\tcat\n")).toBeUndefined();
  });
});

describe("wrapExecCommand", () => {
  test("preserves spaces, quotes, empty args, and a leading dash", () => {
    const command = ["printf", "%s\n", "hello world", `it's`, "", "-dash"];
    expect(wrapExecCommand(command)).toEqual([
      EXEC_UMASK_WRAPPER_SHELL,
      "-c",
      EXEC_UMASK_WRAPPER_SCRIPT,
      EXEC_UMASK_WRAPPER_ARGV0,
      ...command,
    ]);
    expect(isWrappedExecCommand(wrapExecCommand(command))).toBe(true);
    expect(isUmaskProbeCommand(EXEC_UMASK_PROBE_COMMAND)).toBe(true);
    expect(isWorldWritableUmask(WORLD_WRITABLE_UMASK)).toBe(true);
  });

  test("keeps a user argv that starts with -c after lando-exec", () => {
    const command = ["-c", "printf %s hijacked"];
    expect(wrapExecCommand(command)).toEqual([
      EXEC_UMASK_WRAPPER_SHELL,
      "-c",
      EXEC_UMASK_WRAPPER_SCRIPT,
      EXEC_UMASK_WRAPPER_ARGV0,
      "-c",
      "printf %s hijacked",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("umask wrapper process contract", () => {
  const runWrapped = async (command: ReadonlyArray<string>, signal?: NodeJS.Signals) =>
    await new Promise<{
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(wrapExecCommand(command)[0] ?? "/bin/sh", wrapExecCommand(command).slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      if (signal !== undefined) {
        child.on("spawn", () => child.kill(signal));
      }
      child.on("error", reject);
      child.on("close", (exitCode, closedSignal) => {
        resolve({ exitCode, stdout, signal: closedSignal });
      });
    });

  test("passes through a non-zero exit code", async () => {
    const result = await runWrapped(["/bin/sh", "-c", "exit 42"]);
    expect(result.exitCode).toBe(42);
  });

  test("sets umask 0022 for the replaced process", async () => {
    const result = await runWrapped(["/bin/sh", "-c", "umask"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(EXEC_UMASK_COMPENSATION);
  });

  test("preserves an explicit umask in the authored shell command", async () => {
    const result = await runWrapped(["/bin/sh", "-c", "umask 0077; umask"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().padStart(4, "0")).toBe("0077");
  });

  test("forwards argv through the shell without re-quoting", async () => {
    const result = await runWrapped([
      "/bin/sh",
      "-c",
      'printf "%s\\0" "$@"',
      "argv",
      "hello world",
      `it's`,
      "",
      "-dash",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\0")).toEqual(["hello world", `it's`, "", "-dash", ""]);
  });

  test("does not let a user argv that starts with -c become a second shell -c", async () => {
    const result = await runWrapped(["-c", "printf %s hijacked"]);
    expect(result.stdout).not.toContain("hijacked");
    expect(result.exitCode === 0).toBe(false);
  });

  test("delivers SIGTERM to the exec'd process", async () => {
    const result = await runWrapped(["/bin/sh", "-c", "kill -s TERM $$; sleep 5"], undefined);
    expect(result.exitCode === 143 || result.signal === "SIGTERM").toBe(true);
  });
});

describe("exec umask compensation", () => {
  test.each([
    ["0022", "0000"],
    ["0000", "0077"],
  ] as const)("keeps container umasks isolated in order %s then %s", async (first, second) => {
    const fake = makeScriptedApi((cmd, container) =>
      isUmaskProbeCommand(cmd) ? { stdout: umaskStatus(container === containerName ? first : second) } : {},
    );
    await runExec(fake.api, { command: ["id"] });
    await runExec(fake.api, { command: ["id"] }, { app: appId, service: otherService });
    const commands = createBodies(fake.calls).filter((cmd) => cmd[0] === "id" || isWrappedExecCommand(cmd));
    expect(commands).toEqual([
      first === "0000" ? wrapExecCommand(["id"]) : ["id"],
      second === "0000" ? wrapExecCommand(["id"]) : ["id"],
    ]);
    expect(peekExecUmask(fake.api, `cid-${containerName}`)).toEqual({ status: "ok", umask: first });
    expect(peekExecUmask(fake.api, `cid-${otherContainer}`)).toEqual({ status: "ok", umask: second });
  });

  test.each([
    ["0022", "0000"],
    ["0000", "0077"],
  ] as const)("reprobes a recreated container after successful %s before %s", async (first, second) => {
    let generation = 1;
    const fake = makeScriptedApi(
      (cmd) => (isUmaskProbeCommand(cmd) ? { stdout: umaskStatus(generation === 1 ? first : second) } : {}),
      { containerId: () => `generation-${generation}` },
    );
    await runExec(fake.api, { command: ["id"] });
    generation = 2;
    await runExec(fake.api, { command: ["id"] });
    expect(createBodies(fake.calls).filter(isUmaskProbeCommand)).toHaveLength(2);
    expect(createBodies(fake.calls).at(-1)).toEqual(second === "0000" ? wrapExecCommand(["id"]) : ["id"]);
    expect(peekExecUmask(fake.api, "generation-2")).toEqual({ status: "ok", umask: second });
  });

  test.each([undefined, "0"])("invalid exec user does not poison a later user %s", async (user) => {
    const fake = makeScriptedApi((cmd) => (isUmaskProbeCommand(cmd) ? { stdout: umaskStatus("0000") } : {}), {
      failCreate: (_cmd, _container, selectedUser) => selectedUser === "invalid-user",
    });
    await expect(
      runExec(fake.api, { command: ["id"] }, { ...target, user: "invalid-user" }),
    ).rejects.toBeDefined();
    await runExec(fake.api, { command: ["id"] }, { ...target, ...(user === undefined ? {} : { user }) });
    expect(createBodies(fake.calls).at(-1)).toEqual(wrapExecCommand(["id"]));
    expect(peekExecUmask(fake.api, `cid-${containerName}`, "invalid-user")).toEqual({
      status: "unavailable",
    });
    expect(peekExecUmask(fake.api, `cid-${containerName}`, user)).toEqual({ status: "ok", umask: "0000" });
  });

  test("shell denied to one user does not poison root in the same container", async () => {
    const warnings: string[] = [];
    const fake = makeScriptedApi((cmd, _container, user) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000") };
      if (isShellProbeCommand(cmd)) return { exitCode: user === "1000" ? 126 : 0 };
      return {};
    });
    await runExec(fake.api, { command: ["id"] }, { ...target, user: "1000" }, (message) =>
      warnings.push(message),
    );
    await runExec(fake.api, { command: ["id"] }, { ...target, user: "0" }, (message) =>
      warnings.push(message),
    );
    expect(createBodies(fake.calls).filter((cmd) => cmd[0] === "id" || isWrappedExecCommand(cmd))).toEqual([
      ["id"],
      wrapExecCommand(["id"]),
    ]);
    expect(peekContainerHasShell(fake.api, `cid-${containerName}`, "1000")).toBe(false);
    expect(peekContainerHasShell(fake.api, `cid-${containerName}`, "0")).toBe(true);
    expect(warnings).toHaveLength(1);
  });
  test("cancels an in-flight umask probe before starting the user command", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fake = makeScriptedApi(() => ({}));
    const api: EngineHttpApi = {
      ...fake.api,
      stream: (input) => {
        fake.api.stream?.(input);
        markStarted();
        return Stream.never;
      },
    };
    const pending = runExec(api, { command: ["id"], signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      _tag: "ServiceExecError",
      message: "Container exec ended without an observed exit status.",
    });
    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND]]);
  });
  test("does not reuse shell availability or warnings after container recreation", async () => {
    let generation = 1;
    const warnings: string[] = [];
    const fake = makeScriptedApi(
      (cmd) => {
        if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000") };
        if (isShellProbeCommand(cmd)) return { exitCode: generation === 1 ? 127 : 0 };
        return { exitCode: 0 };
      },
      { containerId: () => `cid-${generation}` },
    );
    await runExec(fake.api, { command: ["id"] }, target, (message) => warnings.push(message));
    generation = 2;
    await runExec(fake.api, { command: ["id"] }, target, (message) => warnings.push(message));
    expect(createBodies(fake.calls).filter((cmd) => isShellProbeCommand(cmd))).toHaveLength(2);
    expect(createBodies(fake.calls).at(-1)).toEqual(wrapExecCommand(["id"]));
    expect(warnings).toHaveLength(1);
    expect(peekContainerHasShell(fake.api, "cid-1")).toBe(false);
    expect(peekContainerHasShell(fake.api, "cid-2")).toBe(true);
  });

  test("keeps umask and shell caches isolated between engine connections", async () => {
    const first = makeScriptedApi((cmd) => (isUmaskProbeCommand(cmd) ? { stdout: umaskStatus("0022") } : {}));
    const second = makeScriptedApi((cmd) =>
      isUmaskProbeCommand(cmd) ? { stdout: umaskStatus("0000") } : {},
    );
    await runExec(first.api, { command: ["id"] });
    await runExec(second.api, { command: ["id"] });
    expect(createBodies(first.calls).at(-1)).toEqual(["id"]);
    expect(createBodies(second.calls).at(-1)).toEqual(wrapExecCommand(["id"]));
  });

  test("preserves stdin, TTY, environment, cwd, and user when wrapping", async () => {
    const fake = makeScriptedApi((cmd) => (isUmaskProbeCommand(cmd) ? { stdout: umaskStatus("0000") } : {}));
    const stdinStream = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([65]);
      },
    };
    await Effect.runPromise(
      exec(
        plan,
        { ...target, user: "1000" },
        {
          command: ["cat"],
          stdinStream,
          tty: true,
          cwd: "/tmp",
          env: { EXAMPLE: "two words" },
        },
        { api: fake.api, ctx },
      ),
    );
    const create = fake.calls.filter((call) => call.path.endsWith("/exec")).at(-1);
    expect(create?.body).toMatchObject({
      Cmd: wrapExecCommand(["cat"]),
      AttachStdin: true,
      Tty: true,
      User: "1000",
      WorkingDir: "/tmp",
      Env: ["EXAMPLE=two words"],
    });
    expect(fake.calls.filter((call) => call.path.endsWith("/start")).at(-1)?.stdin).toBe(stdinStream);
  });
  test("wraps the user command when the probed umask is 0000", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000"), exitCode: 0 };
      return { stdout: "ok\n", exitCode: 0 };
    });

    const result = await runExec(fake.api, { command: ["id"] });

    expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
    expect(createBodies(fake.calls)).toEqual([
      [...EXEC_UMASK_PROBE_COMMAND],
      [...EXEC_UMASK_SHELL_PROBE_COMMAND],
      wrapExecCommand(["id"]),
    ]);
    expect(peekExecUmask(fake.api, `cid-${containerName}`)).toEqual({ status: "ok", umask: "0000" });
  });

  test("does not wrap when the probed umask is not 0000", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0022"), exitCode: 0 };
      return { stdout: "ok\n", exitCode: 0 };
    });

    await runExec(fake.api, { command: ["id"] });

    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND], ["id"]]);
  });

  test("caches an ok probe for the same container and user", async () => {
    let probes = 0;
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) {
        probes += 1;
        return { stdout: umaskStatus("0022"), exitCode: 0 };
      }
      return { exitCode: 0 };
    });

    await runExec(fake.api, { command: ["true"] });
    await runExec(fake.api, { command: ["false"] });

    expect(probes).toBe(1);
    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND], ["true"], ["false"]]);
  });

  test("does not wrap a seeded non-world-writable umask", async () => {
    const fake = makeScriptedApi(() => ({ exitCode: 0 }));
    rememberExecUmask(fake.api, `cid-${containerName}`, { status: "ok", umask: "0022" });

    await runExec(fake.api, { command: ["id"] });

    expect(createBodies(fake.calls)).toEqual([["id"]]);
  });

  test("runs the raw command and warns once when /bin/sh is missing", async () => {
    const warnings: string[] = [];
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000"), exitCode: 0 };
      if (isShellProbeCommand(cmd)) return { exitCode: 127 };
      return { stdout: "raw\n", exitCode: 0 };
    });

    const first = await runExec(fake.api, { command: ["id"] }, target, (message) => warnings.push(message));
    const second = await runExec(fake.api, { command: ["id"] }, target, (message) => warnings.push(message));

    expect(first.stdout).toBe("raw\n");
    expect(second.stdout).toBe("raw\n");
    expect(warnings).toEqual([
      "Service web cannot run /bin/sh for the selected exec user; umask compensation is skipped. Files created by exec may be world-writable.",
    ]);
    expect(createBodies(fake.calls).filter((cmd) => cmd[0] === "id")).toEqual([["id"], ["id"]]);
    expect(peekContainerHasShell(fake.api, `cid-${containerName}`)).toBe(false);
  });

  test("keys the missing-shell cache by container id, not service name", async () => {
    const warnings: string[] = [];
    const otherAppId = AppId.make("exec-umask-app-2");
    const otherPlan: AppPlan = {
      ...plan,
      id: otherAppId,
      slug: "exec-umask-app-2",
      root: AbsolutePath.make("/tmp/exec-umask-app-2"),
      services: { [serviceName]: makeService(serviceName) },
    };
    const otherTarget = { app: otherAppId, service: serviceName };
    const otherContainer = "lando-exec-umask-app-2-web";
    const fake = makeScriptedApi((cmd, container) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000"), exitCode: 0 };
      if (isShellProbeCommand(cmd)) return { exitCode: container === otherContainer ? 127 : 0 };
      return { stdout: `${container}\n`, exitCode: 0 };
    });

    await Effect.runPromise(exec(plan, target, { command: ["id"] }, { api: fake.api, ctx }));
    await Effect.runPromise(
      exec(
        otherPlan,
        otherTarget,
        { command: ["id"] },
        { api: fake.api, ctx, onWarn: (message) => warnings.push(message) },
      ),
    );
    await Effect.runPromise(
      exec(
        otherPlan,
        otherTarget,
        { command: ["id"] },
        { api: fake.api, ctx, onWarn: (message) => warnings.push(message) },
      ),
    );

    const bodies = createBodies(fake.calls);
    expect(bodies).toContainEqual(wrapExecCommand(["id"]));
    expect(bodies.filter((cmd) => cmd[0] === "id")).toEqual([["id"], ["id"]]);
    expect(warnings).toEqual([
      "Service web cannot run /bin/sh for the selected exec user; umask compensation is skipped. Files created by exec may be world-writable.",
    ]);
    expect(peekContainerHasShell(fake.api, `cid-${containerName}`)).toBe(true);
    expect(peekContainerHasShell(fake.api, `cid-${otherContainer}`)).toBe(false);
  });

  test("wraps a later working container after an unavailable first probe", async () => {
    const fake = makeScriptedApi((cmd, container) => {
      if (isUmaskProbeCommand(cmd)) {
        return container === containerName ? { exitCode: 127 } : { stdout: umaskStatus("0000"), exitCode: 0 };
      }
      return { stdout: "ok\n", exitCode: 0 };
    });

    await runExec(fake.api, { command: ["id"] }, target);
    await runExec(fake.api, { command: ["id"] }, { app: appId, service: otherService });

    expect(createBodies(fake.calls)).toEqual([
      [...EXEC_UMASK_PROBE_COMMAND],
      ["id"],
      [...EXEC_UMASK_PROBE_COMMAND],
      [...EXEC_UMASK_SHELL_PROBE_COMMAND],
      wrapExecCommand(["id"]),
    ]);
    expect(peekExecUmask(fake.api, `cid-${otherContainer}`)).toEqual({ status: "ok", umask: "0000" });
    expect(peekExecUmask(fake.api, `cid-${containerName}`)).toEqual({ status: "unavailable" });
  });

  test("does not treat a user cat /proc/self/status as the internal probe", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000"), exitCode: 0 };
      return { stdout: umaskStatus("0022"), exitCode: 0 };
    });
    rememberExecUmask(fake.api, `cid-${containerName}`, { status: "ok", umask: "0000" });
    rememberContainerHasShell(fake.api, `cid-${containerName}`, true);

    const result = await runExec(fake.api, { command: [...EXEC_UMASK_PROBE_COMMAND] });

    expect(parseProcSelfStatusUmask(result.stdout)).toBe("0022");
    expect(createBodies(fake.calls)).toEqual([wrapExecCommand([...EXEC_UMASK_PROBE_COMMAND])]);
    expect(peekExecUmask(fake.api, `cid-${containerName}`)).toEqual({ status: "ok", umask: "0000" });
  });

  test("leaves an explicit raw probe unwrapped", async () => {
    const fake = makeScriptedApi(() => ({ stdout: umaskStatus("0000"), exitCode: 0 }));
    rememberExecUmask(fake.api, `cid-${containerName}`, { status: "ok", umask: "0000" });
    rememberContainerHasShell(fake.api, `cid-${containerName}`, true);

    const result = await runExec(fake.api, { command: [...EXEC_UMASK_PROBE_COMMAND], raw: true });

    expect(parseProcSelfStatusUmask(result.stdout)).toBe("0000");
    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND]]);
  });

  test("does not cache an unavailable umask probe on the engine connection", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) return { exitCode: 127 };
      return { exitCode: 0 };
    });

    await runExec(fake.api, { command: ["id"] });

    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND], ["id"]]);
    expect(peekExecUmask(fake.api, `cid-${containerName}`)).toEqual({ status: "unavailable" });
    expect(peekExecUmask(fake.api, `cid-${containerName}`)).toEqual({ status: "unavailable" });
  });

  test("does not cache a shell-probe exit 1 as missing /bin/sh", async () => {
    let shellProbes = 0;
    const fake = makeScriptedApi((cmd) => {
      if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000"), exitCode: 0 };
      if (isShellProbeCommand(cmd)) {
        shellProbes += 1;
        return { exitCode: shellProbes === 1 ? 1 : 0 };
      }
      return { stdout: "ok\n", exitCode: 0 };
    });

    await runExec(fake.api, { command: ["id"] });
    await runExec(fake.api, { command: ["id"] });

    expect(isMissingShellExit(1)).toBe(false);
    expect(shellProbeOutcome(1)).toBe("unknown");
    expect(shellProbeOutcome(126)).toBe("missing");
    expect(shellProbeOutcome(127)).toBe("missing");
    expect(shellProbes).toBe(2);
    expect(peekContainerHasShell(fake.api, `cid-${containerName}`)).toBe(true);
    expect(createBodies(fake.calls).filter((cmd) => cmd[0] === "id")).toEqual([["id"]]);
    expect(createBodies(fake.calls).filter((cmd) => isWrappedExecCommand(cmd))).toEqual([
      wrapExecCommand(["id"]),
    ]);
  });

  test("does not cache a shell-probe transport error as missing /bin/sh", async () => {
    let shellCreates = 0;
    const fake = makeScriptedApi(
      (cmd) => {
        if (isUmaskProbeCommand(cmd)) return { stdout: umaskStatus("0000"), exitCode: 0 };
        return { stdout: "ok\n", exitCode: 0 };
      },
      {
        failCreate: (cmd) => {
          if (!isShellProbeCommand(cmd)) return false;
          shellCreates += 1;
          return shellCreates === 1;
        },
      },
    );

    await runExec(fake.api, { command: ["id"] });
    await runExec(fake.api, { command: ["id"] });

    expect(shellCreates).toBe(2);
    expect(peekContainerHasShell(fake.api, `cid-${containerName}`)).toBe(true);
    expect(createBodies(fake.calls).filter((cmd) => cmd[0] === "id")).toEqual([["id"]]);
    expect(createBodies(fake.calls).filter((cmd) => isWrappedExecCommand(cmd))).toEqual([
      wrapExecCommand(["id"]),
    ]);
  });
});
