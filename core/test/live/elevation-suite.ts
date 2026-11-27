/**
 * The shared harness of the terminal suites that run Lando's elevated commands against real sudo.
 *
 * Guide scenarios never run privileged commands, and the compiled-CLI scenario runner spawns the
 * binary on this host, whose sudo configuration is unknowable. So each suite runs the compiled CLI
 * in a container per sudo variant: Ubuntu 26.04 with sudo-rs, and Debian trixie with classic sudo,
 * each with a `landotest` user whose sudo always asks for a password.
 * `fixtures/elevation/pty-driver.ts` runs every scenario there, as root driving `landotest` on a
 * pseudo-terminal or with no terminal at all, and reports one transcript per scenario. A suite
 * declares its scenarios and asserts on their transcripts.
 *
 * A missing or dead LANDO_TEST_PODMAN_SOCKET skips; LANDO_GUIDE_E2E=1 fails instead.
 */
import { beforeAll, describe, expect } from "bun:test";
import { join } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";
import { ensureCompiledCli } from "../_support/compiled-cli";
import { runElevationContainer } from "./elevation-container";
import type { DriverInput, DriverScenario, Transcript } from "./fixtures/elevation/pty-driver-contract";

/** Set for `landotest` by both Containerfiles. */
export const PASSWORD = "lando-test-pw";
export const LANDO = "/opt/elevation/lando";
export const ANCHOR = "/usr/local/share/ca-certificates/lando-local-ca.crt";
export const CONSENT = "Approve these changes? (y/N): ";
export const ANNOUNCEMENT = "Lando needs administrator access";
/** The border that closes each message block Lando draws, such as the announcement's. */
export const MESSAGE_BLOCK_CLOSE = "╰─";
/** Setup restricted to the stages that run without a container runtime or a user manager. */
export const SETUP = `${LANDO} setup --provider=lando --skip-provider --skip-proxy --skip-shell-integration --skip-file-sync`;
/** Starts the line `EXIT_LINE` prints. */
export const EXIT_MARKER = "__LANDO_EXIT__=";
const ENVELOPE_MARKER = "__LANDO_ENVELOPE__";
const DRIVER_TIMEOUT_MS = 12 * 60_000;

export const VARIANTS = [
  { id: "sudo-rs", prompt: "[sudo: authenticate] Password: ", retry: "Authentication failed, try again." },
  { id: "sudo", prompt: "[sudo] password for landotest: ", retry: "Sorry, try again." },
] as const;
export type Variant = (typeof VARIANTS)[number];

/** Each scenario gets its own Lando roots and `CAROOT`, so it starts with nothing trusted or cached. */
export const scenarioRoots = (id: string) => {
  const root = `/home/landotest/scenarios/${id}`;
  return {
    root,
    data: `${root}/data`,
    cache: `${root}/cache`,
    caroot: `${root}/caroot`,
    mkcert: `${root}/data/bin/mkcert`,
  };
};

const isolate = (id: string) => {
  const { root, data, cache, caroot } = scenarioRoots(id);
  return [
    `mkdir -p ${root}`,
    `export LANDO_USER_DATA_ROOT=${data} LANDO_USER_CONF_ROOT=${root}/conf LANDO_USER_CACHE_ROOT=${cache}`,
    `export LANDO_SYSTEM_PLUGIN_ROOT=${root}/system-plugins CAROOT=${caroot} LANDO_TELEMETRY_ENABLED=false`,
  ].join("; ");
};
/** Prints the exit status of the command before it, which `landoExitCodes` reads. */
export const EXIT_LINE = `printf '\\n${EXIT_MARKER}%d\\n' "$?"`;

/** `command` on the terminal. The trap keeps the shell alive after Ctrl-C so `stty -a` reads it. */
export const onTerminal = (id: string, command: string) =>
  `${isolate(id)}; trap : INT; ${command}; ${EXIT_LINE}; stty -a`;
/** `command` on the terminal, with its stdout (a `--format=json` envelope) printed after it exits. */
export const envelopeOnTerminal = (id: string, command: string) =>
  `${isolate(id)}; ${command} > ~/${id}.json; ${EXIT_LINE}; printf '${ENVELOPE_MARKER}'; cat ~/${id}.json`;
/**
 * `commands` in turn, each in a new session with no terminal at all, as automation runs them,
 * with `env` exported. The transcript's stdout is the last command's.
 */
export const detached = (
  id: string,
  commands: string | readonly string[],
  env: Readonly<Record<string, string>> = {},
) => {
  const all = typeof commands === "string" ? [commands] : commands;
  const exports = Object.entries(env).map(([name, value]) => `export ${name}=${value}; `);
  const runs = all.map(
    (command, index) => `setsid -w ${command} </dev/null${index === all.length - 1 ? "" : " >/dev/null"}`,
  );
  return `${isolate(id)}; ${exports.join("")}${runs.join("; ")}`;
};

export const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(CommandResultEnvelope));

/** Every exit status `EXIT_LINE` printed, in order. */
export const landoExitCodes = (output: string): readonly number[] =>
  [...output.matchAll(new RegExp(`${EXIT_MARKER}(\\d+)`, "gu"))].map((match) => Number(match[1]));
/** The exit status of the scenario's last command. */
export const landoExitCode = (output: string): number | undefined => landoExitCodes(output).at(-1);
/** The terminal modes `stty -a` printed after the last command exited. */
export const terminalModesAfter = (output: string): readonly string[] =>
  output.slice(output.lastIndexOf(EXIT_MARKER)).split(/[\s;]+/u);
/** The commands a run had sudo execute as root, each as the argv after `--`. */
export const rootCommands = (run: Transcript): readonly (readonly string[])[] =>
  run.sudoCalls.filter((call) => call.includes("--")).map((call) => call.slice(call.indexOf("--") + 1));

const summary = (transcript: Transcript): string => {
  const observed = {
    scenario: transcript.id,
    prompts: transcript.prompts,
    rootCommands: rootCommands(transcript).map((argv) => argv[0]),
    trustChanged: transcript.systemTrust.before !== transcript.systemTrust.after,
  };
  switch (transcript.io) {
    case "pty":
      return JSON.stringify({
        ...observed,
        exitCode: landoExitCode(transcript.output),
        ...(transcript.stalled === undefined ? {} : { stalled: transcript.stalled }),
      });
    case "none":
      return JSON.stringify({ ...observed, exitCode: transcript.exitCode });
    default: {
      const exhaustive: never = transcript;
      return exhaustive;
    }
  }
};

export interface SuiteRuns<Id extends string> {
  readonly transcript: (id: Id) => Transcript;
  /** A terminal run that completed every step. */
  readonly terminal: (id: Id) => Extract<Transcript, { readonly io: "pty" }>;
  /** The envelope a terminal run printed with `envelopeOnTerminal`. */
  readonly printedEnvelope: (id: Id) => ReturnType<typeof decodeEnvelope>;
  /** A run without a terminal and the envelope it wrote to stdout. */
  readonly detached: (id: Id) => {
    readonly run: Extract<Transcript, { readonly io: "none" }>;
    readonly envelope: ReturnType<typeof decodeEnvelope>;
  };
}

const socket = resolveLiveProviderSocket();
const required = process.env.LANDO_GUIDE_E2E === "1";
const fixtures = join(import.meta.dir, "fixtures/elevation");

const runScenarios = async (variant: Variant, scenarios: readonly DriverScenario[]) => {
  if (socket === undefined) {
    throw new Error("An answering LANDO_TEST_PODMAN_SOCKET is required with LANDO_GUIDE_E2E=1.");
  }
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY ?? (await ensureCompiledCli());
  const input: DriverInput = { prompt: variant.prompt, scenarios };
  const result = await runElevationContainer({
    socketPath: socket.socketPath,
    variant: variant.id,
    containerfile: await Bun.file(join(fixtures, `Containerfile.${variant.id}`)).text(),
    files: [
      { path: "opt/elevation/lando", mode: 0o755, content: await Bun.file(binary).bytes() },
      {
        path: "opt/elevation/pty-driver.ts",
        mode: 0o644,
        content: await Bun.file(join(fixtures, "pty-driver.ts")).bytes(),
      },
      {
        path: "opt/elevation/scenarios.json",
        mode: 0o644,
        content: new TextEncoder().encode(JSON.stringify(input)),
      },
    ],
    command: ["bun", "/opt/elevation/pty-driver.ts", "/opt/elevation/scenarios.json"],
    timeoutMs: DRIVER_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`The terminal driver exited ${result.exitCode}:\n${result.stderr.join("\n")}`);
  }
  return new Map(
    result.stdout.map((line) => {
      // The driver prints the `Transcript` type it shares with this file.
      const parsed: Transcript = JSON.parse(line);
      return [parsed.id, parsed] as const;
    }),
  );
};

/** One `describe` per sudo variant: its scenarios run in one container, then `body` asserts. */
export const elevationSuite = <Id extends string>(
  name: string,
  scenarios: (variant: Variant) => readonly (DriverScenario & { readonly id: Id })[],
  body: (variant: Variant, runs: SuiteRuns<Id>) => void,
): void => {
  for (const variant of VARIANTS) {
    describe.skipIf(socket === undefined && !required)(`${name} with ${variant.id}`, () => {
      let transcripts: ReadonlyMap<string, Transcript> = new Map();
      const transcript = (id: Id): Transcript => {
        const found = transcripts.get(id);
        if (found === undefined) throw new Error(`The driver reported no transcript for ${id}.`);
        return found;
      };
      const terminal = (id: Id) => {
        const run = transcript(id);
        if (run.io !== "pty") throw new TypeError(`${id} did not run on a terminal.`);
        expect(run.stalled, run.output).toBeUndefined();
        return run;
      };
      const printedEnvelope = (id: Id) => {
        const { output } = terminal(id);
        return decodeEnvelope(output.slice(output.indexOf(ENVELOPE_MARKER) + ENVELOPE_MARKER.length).trim());
      };
      const detachedRun = (id: Id) => {
        const run = transcript(id);
        if (run.io !== "none") throw new TypeError(`${id} ran on a terminal.`);
        return { run, envelope: decodeEnvelope(run.stdout.trim()) };
      };

      beforeAll(
        async () => {
          transcripts = await runScenarios(variant, scenarios(variant));
          for (const run of transcripts.values()) console.info(`[${name}:${variant.id}] ${summary(run)}`);
        },
        // Room for compiling the CLI, building the image, and uploading the binary.
        DRIVER_TIMEOUT_MS + 10 * 60_000,
      );

      body(variant, { transcript, terminal, printedEnvelope, detached: detachedRun });
    });
  }
};
