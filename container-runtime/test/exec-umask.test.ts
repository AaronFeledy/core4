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
import type { CommandSpec } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import {
  EXEC_UMASK_COMPENSATION,
  EXEC_UMASK_PROBE_COMMAND,
  EXEC_UMASK_SHELL_PROBE_COMMAND,
  EXEC_UMASK_WRAPPER_ARGV0,
  EXEC_UMASK_WRAPPER_SCRIPT,
  EXEC_UMASK_WRAPPER_SHELL,
  WORLD_WRITABLE_UMASK,
  isInternalExecProbeCommand,
  isWorldWritableUmask,
  isWrappedExecCommand,
  parseProcSelfStatusUmask,
  peekExecUmask,
  rememberExecUmask,
  rememberServiceHasShell,
  wrapExecCommand,
} from "../src/podman/exec-umask.ts";
import { exec } from "../src/podman/exec.ts";

const ctx = { providerId: "docker", remediation: "Run `lando setup` and retry." } as const;
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
  storage: [],
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
  networks: [],
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

const makeScriptedApi = (scriptFor: (cmd: ReadonlyArray<string>) => FakeExecScript) => {
  const calls: EngineHttpRequest[] = [];
  let nextId = 1;
  const scripts = new Map<string, FakeExecScript>();
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(input);
        if (input.method === "POST" && input.path.endsWith("/exec")) {
          const id = `exec-${nextId}`;
          nextId += 1;
          const cmd = commandOf(input.body) ?? [];
          scripts.set(id, scriptFor(cmd));
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
  execTarget = target,
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
    expect(isInternalExecProbeCommand(EXEC_UMASK_PROBE_COMMAND)).toBe(true);
    expect(isWorldWritableUmask(WORLD_WRITABLE_UMASK)).toBe(true);
  });
});

describe("umask wrapper process contract", () => {
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

  test("delivers SIGTERM to the exec'd process", async () => {
    const result = await runWrapped(["/bin/sh", "-c", "kill -s TERM $$; sleep 5"], undefined);
    expect(result.exitCode === 143 || result.signal === "SIGTERM").toBe(true);
  });
});

describe("exec umask compensation", () => {
  test("wraps the user command when the probed umask is 0000", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (isInternalExecProbeCommand(cmd) && cmd[0] === "cat") {
        return { stdout: umaskStatus("0000"), exitCode: 0 };
      }
      return { stdout: "ok\n", exitCode: 0 };
    });

    const result = await runExec(fake.api, { command: ["id"] });

    expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
    expect(createBodies(fake.calls)).toEqual([
      [...EXEC_UMASK_PROBE_COMMAND],
      [...EXEC_UMASK_SHELL_PROBE_COMMAND],
      wrapExecCommand(["id"]),
    ]);
    expect(peekExecUmask(fake.api)).toEqual({ status: "ok", umask: "0000" });
  });

  test("does not wrap when the probed umask is not 0000", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (isInternalExecProbeCommand(cmd) && cmd[0] === "cat") {
        return { stdout: umaskStatus("0022"), exitCode: 0 };
      }
      return { stdout: "ok\n", exitCode: 0 };
    });

    await runExec(fake.api, { command: ["id"] });

    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND], ["id"]]);
  });

  test("caches the probe per engine connection", async () => {
    let probes = 0;
    const fake = makeScriptedApi((cmd) => {
      if (isInternalExecProbeCommand(cmd) && cmd[0] === "cat") {
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
    rememberExecUmask(fake.api, { status: "ok", umask: "0022" });

    await runExec(fake.api, { command: ["id"] });

    expect(createBodies(fake.calls)).toEqual([["id"]]);
  });

  test("runs the raw command and warns once when /bin/sh is missing", async () => {
    const warnings: string[] = [];
    const fake = makeScriptedApi((cmd) => {
      if (cmd[0] === "cat") return { stdout: umaskStatus("0000"), exitCode: 0 };
      if (cmd[0] === EXEC_UMASK_WRAPPER_SHELL) return { exitCode: 127 };
      return { stdout: "raw\n", exitCode: 0 };
    });

    const first = await runExec(fake.api, { command: ["id"] }, target, (message) => warnings.push(message));
    const second = await runExec(fake.api, { command: ["id"] }, target, (message) => warnings.push(message));

    expect(first.stdout).toBe("raw\n");
    expect(second.stdout).toBe("raw\n");
    expect(warnings).toEqual([
      "Service web has no /bin/sh; exec umask compensation is skipped. Files created by exec may be world-writable.",
    ]);
    expect(createBodies(fake.calls).filter((cmd) => cmd[0] === "id")).toEqual([["id"], ["id"]]);
  });

  test("warns once per service when /bin/sh is missing", async () => {
    const warnings: string[] = [];
    const fake = makeScriptedApi((cmd) => {
      if (cmd[0] === "cat") return { stdout: umaskStatus("0000"), exitCode: 0 };
      if (cmd[0] === EXEC_UMASK_WRAPPER_SHELL) return { exitCode: 127 };
      return { exitCode: 0 };
    });

    await runExec(fake.api, { command: ["true"] }, target, (message) => warnings.push(message));
    await runExec(fake.api, { command: ["true"] }, { app: appId, service: otherService }, (message) =>
      warnings.push(message),
    );

    expect(warnings).toEqual([
      "Service web has no /bin/sh; exec umask compensation is skipped. Files created by exec may be world-writable.",
      "Service db has no /bin/sh; exec umask compensation is skipped. Files created by exec may be world-writable.",
    ]);
  });

  test("leaves the probe command unwrapped so doctor can read the engine umask", async () => {
    const fake = makeScriptedApi(() => ({ stdout: umaskStatus("0000"), exitCode: 0 }));
    rememberExecUmask(fake.api, { status: "ok", umask: "0000" });
    rememberServiceHasShell(fake.api, String(serviceName), true);

    const result = await runExec(fake.api, { command: [...EXEC_UMASK_PROBE_COMMAND] });

    expect(parseProcSelfStatusUmask(result.stdout)).toBe("0000");
    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND]]);
  });

  test("does not wrap when the umask probe is unavailable", async () => {
    const fake = makeScriptedApi((cmd) => {
      if (cmd[0] === "cat") return { exitCode: 127 };
      return { exitCode: 0 };
    });

    await runExec(fake.api, { command: ["id"] });

    expect(createBodies(fake.calls)).toEqual([[...EXEC_UMASK_PROBE_COMMAND], ["id"]]);
    expect(peekExecUmask(fake.api)).toEqual({ status: "unavailable" });
  });
});
