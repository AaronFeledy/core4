import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessExecError } from "@lando/sdk/errors";
import type { ProcessResult } from "@lando/sdk/services";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect, Stream } from "effect";

import { makeWindowsTrust } from "../src/windows-trust.ts";

const { rootA } = TEST_CERTIFICATES;
const SHA1 = new X509Certificate(rootA).fingerprint.replaceAll(":", "");
const STORE = {
  id: "windows",
  name: "Windows certificate store (Edge, Chrome)",
  location: "CurrentUser\\Root",
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-windows-trust-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

type Answer = number | "spawn-failed";

/** Answers each certutil.exe probe with the next exit code, and `wslpath -w` with `wslpath`. */
const fakeRunner = (
  certutil: ReadonlyArray<Answer>,
  wslpath: Answer | string = "C:\\Users\\me\\rootCA.pem",
) => {
  const calls: Array<{ readonly cmd: string; readonly args: ReadonlyArray<string> }> = [];
  const result = (answer: Answer, stdout = ""): Effect.Effect<ProcessResult, ProcessExecError> =>
    answer === "spawn-failed"
      ? Effect.fail(new ProcessExecError({ message: "exec format error", cmd: "x", remediation: "Fix." }))
      : Effect.succeed({ exitCode: answer, stdout, stderr: "" });
  let probes = 0;
  return {
    calls,
    service: {
      run: (input: {
        readonly cmd: string;
        readonly args: ReadonlyArray<string>;
        readonly timeoutMs?: number;
      }) => {
        if (input.timeoutMs === undefined) return Effect.die(new Error("ran without a timeout"));
        calls.push({ cmd: input.cmd, args: [...input.args] });
        if (input.cmd === "wslpath") {
          return typeof wslpath === "string" ? result(0, `${wslpath}\n`) : result(wslpath);
        }
        return result(certutil[probes++] ?? 1);
      },
      stream: () => Stream.die(new Error("unused")),
      streamWithExit: () => Stream.die(new Error("unused")),
    },
  };
};

const setup = async (options: {
  readonly wsl: boolean;
  readonly onPath: boolean;
  readonly fallback: boolean;
}) => {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  if (options.wsl) await writeFile(join(dir, "WSLInterop-late"), "enabled\n");
  if (options.onPath) {
    await writeFile(join(bin, "certutil.exe"), "");
    await chmod(join(bin, "certutil.exe"), 0o755);
  }
  if (options.fallback) await writeFile(join(dir, "fallback-certutil.exe"), "");
  return {
    paths: {
      interop: [join(dir, "WSLInterop"), join(dir, "WSLInterop-late")],
      certutil: join(dir, "fallback-certutil.exe"),
    },
    bin,
  };
};

const inspect = async (
  runner: ReturnType<typeof fakeRunner>,
  options: {
    readonly wsl?: boolean;
    readonly onPath?: boolean;
    readonly fallback?: boolean;
    readonly platform?: string;
  } = {},
) => {
  const { paths, bin } = await setup({
    wsl: options.wsl ?? true,
    onPath: options.onPath ?? true,
    fallback: options.fallback ?? false,
  });
  const trust = makeWindowsTrust({
    processRunner: runner.service,
    env: { PATH: bin },
    platform: options.platform ?? "linux",
    paths,
  });
  return { rows: await Effect.runPromise(trust.inspect("/home/me/.local/share/mkcert", rootA)), bin, paths };
};

describe("Windows certificate store under WSL", () => {
  test.each([
    { wsl: false, platform: "linux" },
    { wsl: true, platform: "darwin" },
  ])("reports no row unless WSL interop is present on Linux ($platform, wsl=$wsl)", async (options) => {
    const runner = fakeRunner([0]);
    expect((await inspect(runner, options)).rows).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  test.each([
    { answers: [0], probes: 1, location: "CurrentUser\\Root" },
    { answers: [17, 0], probes: 2, location: "LocalMachine\\Root" },
  ] as const)(
    "checks the user then the machine Root store ($answers -> trusted in $location)",
    async ({ answers, probes, location }) => {
      const runner = fakeRunner(answers);
      const { rows, bin } = await inspect(runner);
      expect(rows).toEqual([{ ...STORE, location, state: "trusted" }]);
      expect(runner.calls).toEqual(
        [
          { cmd: join(bin, "certutil.exe"), args: ["-user", "-store", "Root", SHA1] },
          { cmd: join(bin, "certutil.exe"), args: ["-store", "Root", SHA1] },
        ].slice(0, probes),
      );
    },
  );

  test("an absent root gets a pasteable, non-elevated PowerShell import using the Windows path", async () => {
    const runner = fakeRunner([17, 17], "\\\\wsl.localhost\\Ubuntu\\home\\o'neil\\rootCA.pem");
    const { rows } = await inspect(runner);
    expect(rows).toEqual([
      {
        ...STORE,
        state: "untrusted",
        reason: "missing",
        detail: "Neither the Windows user nor machine Root store holds the local CA.",
        remediation:
          "In Windows PowerShell, run `certutil -user -addstore Root '\\\\wsl.localhost\\Ubuntu\\home\\o''neil\\rootCA.pem'` and approve the prompt, then run `lando doctor`.",
      },
    ]);
    expect(runner.calls.at(-1)).toEqual({
      cmd: "wslpath",
      args: ["-w", "/home/me/.local/share/mkcert/rootCA.pem"],
    });
    expect(runner.calls.some(({ args }) => args.includes("-addstore"))).toBe(false);
  });

  test("describes the file when wslpath fails", async () => {
    const { rows } = await inspect(fakeRunner([17, 17], 1));
    expect(rows[0]?.remediation).toBe(
      "Copy /home/me/.local/share/mkcert/rootCA.pem to Windows, then in Windows PowerShell run `certutil -user -addstore Root '<copied rootCA.pem>'` and approve the prompt, then run `lando doctor`.",
    );
  });

  test("falls back to the System32 certutil.exe when it is not on PATH", async () => {
    const runner = fakeRunner([0]);
    const { rows, paths } = await inspect(runner, { onPath: false, fallback: true });
    expect(rows).toEqual([{ ...STORE, state: "trusted" }]);
    expect(runner.calls[0]?.cmd).toBe(paths.certutil);
  });

  test.each([
    { name: "no certutil.exe exists", answers: [0], onPath: false },
    { name: "certutil.exe cannot start", answers: ["spawn-failed"], onPath: true },
  ] as const)("is unknown when $name", async ({ answers, onPath }) => {
    const { rows } = await inspect(fakeRunner(answers), { onPath });
    expect(rows).toEqual([
      expect.objectContaining({ ...STORE, state: "unknown", reason: "interop-unavailable" }),
    ]);
  });
});
