import { expect, test } from "bun:test";
import { HostChangeId } from "@lando/sdk/schema";
import { Schema } from "effect";
import { SetupResultSchema } from "../../src/cli/command-specs/meta/setup-inputs";
import {
  ANCHOR,
  ANNOUNCEMENT,
  CONSENT,
  LANDO,
  MESSAGE_BLOCK_CLOSE,
  PASSWORD,
  SETUP,
  type Variant,
  detached,
  elevationSuite,
  envelopeOnTerminal,
  landoExitCode,
  onTerminal,
  rootCommands,
  scenarioRoots,
  terminalModesAfter,
} from "./elevation-suite";
import type { DriverScenario, Transcript } from "./fixtures/elevation/pty-driver-contract";

/**
 * `lando setup` elevating against real sudo on a real terminal (harness: `elevation-suite.ts`).
 *
 * Setup plans every host change first, asks consent once, opens one sudo session, then applies.
 * Restricted to the certificate authority, its one planned change is trusting the local CA in the
 * system store: fixed root commands write the CA certificate into the image's real
 * `update-ca-certificates` anchor directory. Setup downloads mkcert for it (CI has egress). The
 * provider, router, and shell stages need a container runtime or a systemd user manager, which
 * these containers do not have, so no task tree opens in these runs.
 */
const CA_TRUST = HostChangeId.make("ca-mkcert:trust-system-store");
const ASKPASS = "/usr/local/libexec/lando-test-askpass";
/** The border that opens an info message block. */
const INFO_BLOCK_OPEN = "╭─ INFO";
const TRUSTED_ANCHOR = { kind: "file", uid: 0, gid: 0, mode: 0o644 } as const;
const decodeSetupResult = Schema.decodeUnknownSync(SetupResultSchema);
// Color is allowed between the announcement and the password; cursor movement and erasing are not.
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences start with the escape byte.
const SGR = /\x1b\[[0-9;]*m/gu;

type ScenarioId =
  | "dry-run"
  | "consent-skipped"
  | "no-credentials"
  | "interrupt"
  | "prompt"
  | "retry"
  | "askpass"
  | "undo"
  | "undo-needs-purge";

const base = (id: ScenarioId) => {
  const { caroot, mkcert } = scenarioRoots(id);
  return { id, caroot, observe: [ANCHOR, `${caroot}/rootCA.pem`, mkcert] };
};
const unattended = `${SETUP} --no-interactive --format=json`;
const UNINSTALL_UNDO = `${LANDO} uninstall --yes --undo ${CA_TRUST} --format=json`;
const askpass = {
  // The helper automation points SUDO_ASKPASS at, installed by the administrator.
  prepare: `mkdir -p ${ASKPASS.slice(0, ASKPASS.lastIndexOf("/"))} && printf '#!/bin/sh\\necho ${PASSWORD}\\n' > ${ASKPASS} && chmod 0755 ${ASKPASS}`,
  env: { SUDO_ASKPASS: ASKPASS },
};
/** Setup trusts the CA unattended, then uninstall runs `uninstall` arguments the same way. */
const setupThenUninstall = (id: ScenarioId, uninstall: string) => ({
  ...base(id),
  observe: [ANCHOR, scenarioRoots(id).data],
  io: "none" as const,
  prepare: askpass.prepare,
  script: detached(id, [`${unattended} --yes`, uninstall], askpass.env),
});

const scenarios = (variant: Variant): readonly (DriverScenario & { readonly id: ScenarioId })[] => [
  // On a terminal, where a real run could prompt.
  {
    ...base("dry-run"),
    io: "pty",
    script: envelopeOnTerminal("dry-run", `${SETUP} --dry-run --format=json`),
    steps: [],
  },
  { ...base("consent-skipped"), io: "none", script: detached("consent-skipped", unattended) },
  { ...base("no-credentials"), io: "none", script: detached("no-credentials", `${unattended} --yes`) },
  {
    ...base("interrupt"),
    io: "pty",
    script: onTerminal("interrupt", `${SETUP} --yes`),
    steps: [{ kind: "expect", text: variant.prompt }, { kind: "interrupt" }],
  },
  {
    ...base("prompt"),
    io: "pty",
    script: onTerminal("prompt", SETUP),
    steps: [
      { kind: "expect", text: CONSENT },
      { kind: "answer", text: "y" },
      { kind: "expect", text: ANNOUNCEMENT },
      { kind: "expect", text: MESSAGE_BLOCK_CLOSE },
      { kind: "expect", text: variant.prompt },
      { kind: "password", text: PASSWORD },
    ],
  },
  {
    ...base("retry"),
    io: "pty",
    script: onTerminal("retry", `${SETUP} --yes`),
    steps: [
      { kind: "expect", text: variant.prompt },
      { kind: "password", text: "not-the-password" },
      { kind: "expect", text: variant.retry },
      { kind: "expect", text: variant.prompt },
      { kind: "password", text: PASSWORD },
    ],
  },
  {
    ...base("askpass"),
    io: "none",
    prepare: askpass.prepare,
    script: detached("askpass", `${unattended} --yes`, askpass.env),
  },
  setupThenUninstall("undo", UNINSTALL_UNDO.replace("uninstall ", "uninstall --purge ")),
  setupThenUninstall("undo-needs-purge", UNINSTALL_UNDO),
];

const changedNothing = (run: Transcript) => {
  expect(run.systemTrust.after).toBe(run.systemTrust.before);
  expect(run.paths[ANCHOR]).toBeNull();
  expect(rootCommands(run)).toEqual([]);
};

elevationSuite("lando setup elevation", scenarios, (variant, runs) => {
  const plannedTrust = () => {
    const result = decodeSetupResult(runs.printedEnvelope("dry-run").result);
    if (!result.dryRun) throw new TypeError("`lando setup --dry-run` returned an applied result.");
    const entry = result.changes.find(({ change }) => change.id === CA_TRUST);
    if (entry === undefined) throw new Error(`The dry run planned no ${CA_TRUST}.`);
    return { result, entry };
  };

  const trustCommands = () => plannedTrust().entry.change.steps.map(({ argv }) => argv);
  const undoCommands = () => {
    const { undo } = plannedTrust().entry.change;
    if (undo._tag !== "steps") throw new TypeError(`${CA_TRUST} plans no undo commands.`);
    return undo.steps.map(({ argv }) => argv);
  };

  test("a dry run on a terminal lists the CA trust change with its root commands and says sudo would prompt", () => {
    const { result, entry } = plannedTrust();
    expect(result.elevation.state).toBe("will-prompt");
    expect(entry.approval).toBe("will-ask");
    expect(entry.change.details?.anchor).toBe(ANCHOR);
    expect(entry.change.steps.every(({ privileged, argv }) => privileged && argv[0].startsWith("/"))).toBe(
      true,
    );
  });

  test("a dry run changes nothing, never prompts, and has sudo run nothing", () => {
    const run = runs.terminal("dry-run");
    const { caroot, mkcert } = scenarioRoots("dry-run");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(run.prompts).toBe(0);
    changedNothing(run);
    expect(run.paths[`${caroot}/rootCA.pem`]).toBeNull();
    expect(run.paths[mkcert]).toBeNull();
    // Its one sudo use is the credential check, which can neither prompt nor run a command.
    expect(
      run.sudoCalls.every((call) => call.join(" ") === "-n -v"),
      JSON.stringify(run.sudoCalls),
    ).toBe(true);
  });

  test("consent comes first, then Lando's announcement, then sudo's own prompt, and Lando draws nothing until the password's newline", () => {
    const run = runs.terminal("prompt");
    const [, , , close, prompt, password] = run.marks;
    if (close === undefined || prompt === undefined || password === undefined) throw new Error(run.output);
    const beforePrompt = run.output.slice(close.at + MESSAGE_BLOCK_CLOSE.length, prompt.at).replace(SGR, "");
    expect(beforePrompt, run.output).toBe("\r\n");
    const afterPrompt = run.output.slice(
      prompt.at + variant.prompt.length,
      run.output.indexOf("\n", password.at) + 1,
    );
    // sudo-rs echoes an asterisk per key and erases them on Enter; classic sudo echoes nothing.
    expect(afterPrompt, run.output).toMatch(/^[*\b ]*\r\n$/u);
  });

  test("one setup run asks for the sudo password exactly once", () => {
    expect(runs.terminal("prompt").prompts).toBe(1);
  });

  test("after the password, setup has sudo run exactly the dry run's commands and the anchor is trusted", () => {
    const run = runs.terminal("prompt");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(rootCommands(run)).toEqual(plannedTrust().entry.change.steps.map(({ argv }) => argv));
    expect(run.paths[ANCHOR]).toEqual(TRUSTED_ANCHOR);
    expect(run.systemTrust.rootTrusted).toBe(true);
  });

  test("Lando's event output renders again after the password's newline", () => {
    const run = runs.terminal("prompt");
    const password = run.marks.at(-1);
    if (password === undefined) throw new Error(run.output);
    expect(run.output.indexOf(INFO_BLOCK_OPEN, password.at), run.output).toBeGreaterThan(-1);
  });

  test("a wrong password gets sudo's own retry line and second prompt under Lando's one announcement", () => {
    const run = runs.terminal("retry");
    expect(run.prompts).toBe(2);
    expect(run.output.split(ANNOUNCEMENT).length - 1).toBe(1);
  });

  test("after a wrong and then the right password, setup trusts the CA", () => {
    const run = runs.terminal("retry");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(run.systemTrust.rootTrusted).toBe(true);
  });

  test("Ctrl-C at sudo's prompt exits 130 and changes nothing", () => {
    const run = runs.terminal("interrupt");
    expect(landoExitCode(run.output), run.output).toBe(130);
    changedNothing(run);
  });

  test("Ctrl-C at sudo's prompt leaves the terminal echoing in canonical mode", () => {
    const modes = terminalModesAfter(runs.terminal("interrupt").output);
    expect(modes).toContain("echo");
    expect(modes).toContain("icanon");
  });

  test("SUDO_ASKPASS with --yes and no terminal never shows a password prompt", () => {
    expect(runs.transcript("askpass").prompts).toBe(0);
  });

  // #2720: mkcert's own sudo could not see the ticket `sudo -A -v` created without a terminal.
  test("SUDO_ASKPASS with --yes and no terminal trusts the CA (#2720)", () => {
    const { run, envelope } = runs.detached("askpass");
    expect(envelope.ok, run.stdout).toBe(true);
    expect(run.paths[ANCHOR]).toEqual(TRUSTED_ANCHOR);
    expect(run.systemTrust.rootTrusted).toBe(true);
  });

  test("--yes without a terminal or SUDO_ASKPASS fails with PrivilegeCredentialsRequiredError before any change", () => {
    const { run, envelope } = runs.detached("no-credentials");
    const { caroot, mkcert } = scenarioRoots("no-credentials");
    expect(envelope.error?._tag, run.stdout).toBe("PrivilegeCredentialsRequiredError");
    expect(run.exitCode).not.toBe(0);
    changedNothing(run);
    expect(run.paths[`${caroot}/rootCA.pem`]).toBeNull();
    expect(run.paths[mkcert]).toBeNull();
  });

  test("a non-interactive run without --yes skips the recommended CA trust and changes nothing", () => {
    const { run, envelope } = runs.detached("consent-skipped");
    expect(envelope.ok, run.stdout).toBe(true);
    const result = decodeSetupResult(envelope.result);
    if (result.dryRun) throw new TypeError("A real run returned a dry-run result.");
    expect(result.hostChanges).toContainEqual({ id: CA_TRUST, outcome: "declined" });
    changedNothing(run);
  });

  test("uninstall --purge --undo removes the anchor setup wrote, through its recorded undo commands", () => {
    const { run, envelope } = runs.detached("undo");
    expect(envelope.ok, run.stdout).toBe(true);
    expect(rootCommands(run)).toEqual([...trustCommands(), ...undoCommands()]);
    expect(run.paths[ANCHOR]).toBeNull();
    expect(run.systemTrust.rootTrusted).toBe(false);
  });

  test("uninstall --undo without --purge fails with UninstallUndoNeedsPurgeError and changes nothing", () => {
    const { run, envelope } = runs.detached("undo-needs-purge");
    expect(envelope.error?._tag, run.stdout).toBe("UninstallUndoNeedsPurgeError");
    expect(rootCommands(run)).toEqual(trustCommands());
    expect(run.paths[ANCHOR]).toEqual(TRUSTED_ANCHOR);
    expect(run.paths[scenarioRoots("undo-needs-purge").data]?.kind).toBe("directory");
  });
});
