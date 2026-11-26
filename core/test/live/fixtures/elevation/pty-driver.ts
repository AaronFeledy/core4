/**
 * Terminal driver for `setup-elevation-pty-live.integration.test.ts`.
 *
 * The suite uploads this file with the compiled CLI into a test container and runs it there as
 * root with the image's Bun. Each scenario runs its bash script as `landotest` through `setpriv`,
 * either on a fresh pseudo-terminal, where it follows the scenario's steps the way a person at the
 * keyboard would, or with no terminal at all. The driver prints one JSON transcript line per
 * scenario on stdout. It runs alone in the container, so it imports only Node builtins and types.
 *
 * Every scenario starts from the image's own trust store, and the driver records each sudo
 * invocation through a wrapper that execs the real sudo, so the process sudo sees is unchanged.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";

import type {
  DriverInput,
  DriverScenario,
  PathFacts,
  StepMark,
  TerminalStep,
  Transcript,
} from "./pty-driver-contract.ts";

const USER = "landotest";
const ANCHORS = "/usr/local/share/ca-certificates";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const SUDO = "/usr/bin/sudo";
const SUDO_CALLS = "/var/log/lando-test-sudo-calls";
// Ahead of the real sudo on the login PATH. `exec` keeps the pid, session, and terminal, which
// sudo's credential ticket is keyed on. Fields end in US (0x1f), invocations in RS (0x1e).
const SUDO_WRAPPER = `#!/bin/sh
{ for arg in "$@"; do printf '%s\\037' "$arg"; done; printf '\\036'; } >> ${SUDO_CALLS}
exec ${SUDO} "$@"
`;
// Setup downloads mkcert before its first elevated step, so a step may wait on the network.
const STEP_TIMEOUT_MS = 120_000;
const DRAIN_TIMEOUT_MS = 5_000;
// No event reports a termios change, so echo state is re-read at this interval while waiting.
const POLL_MS = 25;
// termios c_lflag ECHO on Linux.
const ECHO = 0o10;

const command = (script: string): string[] => [
  "/usr/bin/setpriv",
  "--reuid",
  USER,
  "--regid",
  USER,
  "--init-groups",
  "--reset-env",
  "--",
  "bash",
  "-lc",
  script,
];

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const missingAsUndefined = (cause: unknown): undefined => {
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
  throw cause;
};

const runAsRoot = async (args: readonly string[]): Promise<void> => {
  const proc = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    throw new Error(`${args.join(" ")} exited ${proc.exitCode}:\n${stdout}${stderr}`);
  }
};

const systemTrustDigest = async (): Promise<string> =>
  createHash("sha256")
    .update((await readdir(ANCHORS)).sort().join("\n"))
    .update(await readFile(BUNDLE))
    .digest("hex");

const bundleHolds = async (caroot: string): Promise<boolean> => {
  const root = await readFile(`${caroot}/rootCA.pem`, "utf8").catch(missingAsUndefined);
  if (root === undefined) return false;
  const compact = (pem: string) => pem.replace(/\s/gu, "");
  return compact(await readFile(BUNDLE, "utf8")).includes(compact(root));
};

/** Removes anchors an earlier scenario added and rebuilds the bundle from the image's own. */
const restoreSystemTrust = async (imageAnchors: ReadonlySet<string>): Promise<void> => {
  const added = (await readdir(ANCHORS)).filter((name) => !imageAnchors.has(name));
  if (added.length === 0) return;
  for (const name of added) await rm(`${ANCHORS}/${name}`, { recursive: true });
  await runAsRoot(["/usr/sbin/update-ca-certificates", "--fresh"]);
};

const describePath = async (path: string): Promise<PathFacts | null> => {
  const stats = await lstat(path).catch(missingAsUndefined);
  if (stats === undefined) return null;
  const kind = stats.isSymbolicLink()
    ? "symlink"
    : stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : "other";
  const facts = { kind, uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o7777 } as const;
  return kind === "symlink" ? { ...facts, target: await readlink(path) } : facts;
};

const sudoCalls = async (): Promise<string[][]> =>
  (await readFile(SUDO_CALLS, "utf8"))
    .split("\x1e")
    .filter((call) => call.length > 0)
    .map((call) => call.split("\x1f").slice(0, -1));

const runOnTerminal = async (script: string, steps: readonly TerminalStep[], prompt: string) => {
  const decoder = new TextDecoder();
  let output = "";
  let changed = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const proc = Bun.spawn(command(script), {
    env: { TERM: "xterm-256color" },
    terminal: {
      cols: 200,
      rows: 50,
      data: (_terminal, bytes) => {
        output += decoder.decode(bytes, { stream: true });
        changed.resolve();
        changed = Promise.withResolvers<void>();
      },
      exit: () => drained.resolve(),
    },
  });
  const terminal = proc.terminal;
  if (terminal === undefined) throw new TypeError("Bun.spawn did not attach a terminal.");
  const running = () => proc.exitCode === null && proc.signalCode === null;
  const until = async (ready: () => boolean): Promise<boolean> => {
    const deadline = performance.now() + STEP_TIMEOUT_MS;
    while (!ready()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || !running()) return false;
      await Promise.race([changed.promise, proc.exited, Bun.sleep(Math.min(remaining, POLL_MS))]);
    }
    return true;
  };
  const reading = () => (terminal.localFlags & ECHO) === 0;

  const marks: StepMark[] = [];
  let cursor = 0;
  let stalled: string | undefined;
  for (const [index, step] of steps.entries()) {
    switch (step.kind) {
      case "expect": {
        if (!(await until(() => output.includes(step.text, cursor)))) {
          stalled = `step ${index}: expect ${JSON.stringify(step.text)}`;
          break;
        }
        const at = output.indexOf(step.text, cursor);
        marks.push({ kind: step.kind, at, sudoCalls: (await sudoCalls()).length });
        cursor = at + step.text.length;
        break;
      }
      case "answer":
        marks.push({ kind: step.kind, at: output.length, sudoCalls: (await sudoCalls()).length });
        terminal.write(`${step.text}\r`);
        break;
      case "password":
      case "interrupt": {
        if (!(await until(reading))) {
          stalled = `step ${index}: ${step.kind} (the terminal never stopped echoing)`;
          break;
        }
        marks.push({ kind: step.kind, at: output.length, sudoCalls: (await sudoCalls()).length });
        terminal.write(step.kind === "password" ? `${step.text}\r` : "\x03");
        break;
      }
      default: {
        const exhaustive: never = step;
        return exhaustive;
      }
    }
    if (stalled !== undefined) break;
  }
  if (stalled === undefined && !(await until(() => !running()))) stalled = "exit";
  // Killing the session leader hangs up the rest of the session.
  if (running()) proc.kill("SIGKILL");
  await proc.exited;
  await Promise.race([drained.promise, Bun.sleep(DRAIN_TIMEOUT_MS)]);
  terminal.close();
  output += decoder.decode();
  return {
    io: "pty" as const,
    exitCode: proc.exitCode,
    prompts: occurrences(output, prompt),
    output,
    marks,
    ...(stalled === undefined ? {} : { stalled }),
  };
};

const runWithoutTerminal = async (script: string, prompt: string) => {
  const proc = Bun.spawn(command(script), {
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return {
    io: "none" as const,
    exitCode: proc.exitCode,
    prompts: occurrences(`${stdout}${stderr}`, prompt),
    stdout,
    stderr,
  };
};

const runIo = (scenario: DriverScenario, prompt: string) => {
  switch (scenario.io) {
    case "pty":
      return runOnTerminal(scenario.script, scenario.steps, prompt);
    case "none":
      return runWithoutTerminal(scenario.script, prompt);
    default: {
      const exhaustive: never = scenario;
      return exhaustive;
    }
  }
};

const runScenario = async (
  prompt: string,
  scenario: DriverScenario,
  imageAnchors: ReadonlySet<string>,
): Promise<Transcript> => {
  await restoreSystemTrust(imageAnchors);
  if (scenario.prepare !== undefined) await runAsRoot(["/bin/bash", "-c", scenario.prepare]);
  await writeFile(SUDO_CALLS, "");
  await chmod(SUDO_CALLS, 0o666);
  const describe = async () => {
    const paths: Record<string, PathFacts | null> = {};
    for (const path of scenario.observe) paths[path] = await describePath(path);
    return paths;
  };
  const before = await systemTrustDigest();
  const pathsBefore = await describe();
  const run = await runIo(scenario, prompt);
  const paths = await describe();
  return {
    id: scenario.id,
    sudoCalls: await sudoCalls(),
    systemTrust: {
      before,
      after: await systemTrustDigest(),
      rootTrusted: await bundleHolds(scenario.caroot),
    },
    pathsBefore,
    paths,
    ...run,
  };
};

const [inputPath] = process.argv.slice(2);
if (inputPath === undefined) throw new TypeError("usage: bun pty-driver.ts <scenarios.json>");
// The suite writes this file from the same `DriverInput` type.
const input: DriverInput = JSON.parse(await Bun.file(inputPath).text());
await writeFile("/usr/local/bin/sudo", SUDO_WRAPPER, { mode: 0o755 });
const imageAnchors = new Set(await readdir(ANCHORS));
for (const scenario of input.scenarios) {
  process.stdout.write(`${JSON.stringify(await runScenario(input.prompt, scenario, imageAnchors))}\n`);
}
