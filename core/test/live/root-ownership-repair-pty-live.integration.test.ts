import { expect, test } from "bun:test";
import { HostChangeId } from "@lando/sdk/schema";
import { Schema } from "effect";
import { SetupResultSchema } from "../../src/cli/command-specs/meta/setup-inputs";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-contract";
import {
  ANNOUNCEMENT,
  CONSENT,
  EXIT_LINE,
  EXIT_MARKER,
  LANDO,
  PASSWORD,
  SETUP,
  type Variant,
  detached,
  elevationSuite,
  envelopeOnTerminal,
  landoExitCode,
  landoExitCodes,
  onTerminal,
  rootCommands,
  scenarioRoots,
} from "./elevation-suite";
import type { DriverScenario, TerminalStep } from "./fixtures/elevation/pty-driver-contract";
import {
  type Leftovers,
  expectedWalkerCall,
  givenBack,
  layout,
  leftovers,
  unchanged,
  walkerCall,
} from "./root-ownership-leftovers";

/**
 * Lando giving back the root-owned files that running it with sudo leaves under its roots, against
 * real sudo on a real terminal (harness: `elevation-suite.ts`). Root creates the leftovers first:
 * a directory with a file in it, a file, a symlink to `/etc/shadow` (which Lando must never
 * follow), and in one scenario a hard link to a root file outside Lando's roots (whose owner Lando
 * must never change, so setup refuses before asking anything). `lando setup` plans the repair with
 * trusting the local CA and asks sudo once for both; `lando doctor --fix --section lando-roots`
 * repairs after asking in a terminal, and without one changes nothing and says how to.
 */
const REPAIR = HostChangeId.make("core:repair-root-ownership");
const CA_TRUST = HostChangeId.make("ca-mkcert:trust-system-store");
const DOCTOR_FIX = `${LANDO} doctor --fix --section lando-roots --format=json`;
const decodeSetupResult = Schema.decodeUnknownSync(SetupResultSchema);
const decodeDoctorReport = Schema.decodeUnknownSync(DoctorReportSchema);

type ScenarioId = "dry-run" | "repair" | "hard-link" | "no-data-root" | "doctor-fix" | "doctor-no-terminal";

const scenario = (id: ScenarioId, kind: Leftovers, dataRoot = true) => ({
  id,
  caroot: scenarioRoots(id).caroot,
  prepare: leftovers(id, kind, dataRoot),
  observe: [...Object.values(layout(id)), scenarioRoots(id).data, "/etc/shadow"],
});
const approve = (variant: Variant): readonly TerminalStep[] => [
  { kind: "expect", text: CONSENT },
  { kind: "answer", text: "y" },
  { kind: "expect", text: variant.prompt },
  { kind: "password", text: PASSWORD },
];

const scenarios = (variant: Variant): readonly (DriverScenario & { readonly id: ScenarioId })[] => [
  {
    ...scenario("dry-run", "full"),
    io: "pty",
    script: envelopeOnTerminal("dry-run", `${SETUP} --dry-run --format=json`),
    steps: [],
  },
  { ...scenario("repair", "full"), io: "pty", script: onTerminal("repair", SETUP), steps: approve(variant) },
  {
    ...scenario("hard-link", "full-with-hard-link"),
    io: "pty",
    // The user runs the command setup gave for the hard link, then setup again.
    script: onTerminal(
      "hard-link",
      `${SETUP}; ${EXIT_LINE}; rm -f '${layout("hard-link").hardLink}'; ${SETUP}`,
    ),
    steps: [{ kind: "expect", text: EXIT_MARKER }, ...approve(variant)],
  },
  // Running lando with sudo before setup ever ran can leave a cache root and no data root.
  {
    ...scenario("no-data-root", "file-only", false),
    io: "pty",
    script: onTerminal("no-data-root", SETUP),
    steps: approve(variant),
  },
  {
    ...scenario("doctor-fix", "file-only"),
    io: "pty",
    script: envelopeOnTerminal("doctor-fix", DOCTOR_FIX),
    steps: approve(variant),
  },
  {
    ...scenario("doctor-no-terminal", "file-only"),
    io: "none",
    script: detached("doctor-no-terminal", DOCTOR_FIX),
  },
];

elevationSuite("lando root-ownership repair", scenarios, (_variant, runs) => {
  const planned = (id: HostChangeId) => {
    const result = decodeSetupResult(runs.printedEnvelope("dry-run").result);
    if (!result.dryRun) throw new TypeError("`lando setup --dry-run` returned an applied result.");
    const entry = result.changes.find(({ change }) => change.id === id);
    if (entry === undefined) throw new Error(`The dry run planned no ${id}.`);
    return entry;
  };
  /** The first setup run of the hard-link scenario: everything before it printed its exit status. */
  const refusedRun = () => {
    const run = runs.terminal("hard-link");
    const [exited] = run.marks;
    if (exited === undefined) throw new Error(run.output);
    return { run, output: run.output.slice(0, exited.at), sudoCalls: exited.sudoCalls };
  };

  test("a dry run plans giving the root-owned paths back as one required root command, never naming the symlink", () => {
    const run = runs.terminal("dry-run");
    const { dir, file } = layout("dry-run");
    const entry = planned(REPAIR);
    expect(entry.approval).toBe("will-ask");
    expect(entry.change.requirement).toBe("required");
    expect(entry.change.steps.map(({ privileged }) => privileged)).toEqual([true]);
    expect(walkerCall(entry.change.steps[0].argv)).toEqual(expectedWalkerCall(run, [dir, file]));
  });

  test("a dry run with root-owned files changes nothing, never prompts, and has sudo run nothing", () => {
    const run = runs.terminal("dry-run");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(run.prompts).toBe(0);
    unchanged(run, Object.keys(run.pathsBefore));
    expect(rootCommands(run)).toEqual([]);
  });

  test("one setup run gives root-owned files back and trusts the CA under one announcement and one sudo prompt", () => {
    const run = runs.terminal("repair");
    expect(run.prompts).toBe(1);
    expect(run.output.split(ANNOUNCEMENT).length - 1).toBe(1);
  });

  test("setup has sudo run exactly the planned walker and CA commands", () => {
    const run = runs.terminal("repair");
    const { dir, file } = layout("repair");
    const [walker, ...trust] = rootCommands(run);
    expect(walker === undefined ? undefined : walkerCall(walker)).toEqual(
      expectedWalkerCall(run, [dir, file]),
    );
    expect(trust).toEqual(planned(CA_TRUST).change.steps.map(({ argv }) => argv));
  });

  test("the root-owned directory, its contents, and the file now belong to landotest with their modes kept", () => {
    const { dir, dirFile, file } = layout("repair");
    givenBack(runs.terminal("repair"), [dir, dirFile, file]);
  });

  test("the root-owned symlink and /etc/shadow it points to are untouched", () => {
    const run = runs.terminal("repair");
    unchanged(run, [layout("repair").symlink, "/etc/shadow"]);
    expect(run.paths[layout("repair").symlink]?.target).toBe("/etc/shadow");
  });

  test("after giving the files back, setup finishes and trusts the CA", () => {
    const run = runs.terminal("repair");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(run.systemTrust.rootTrusted).toBe(true);
  });

  test("with a root-owned hard link, setup fails before any question, sudo call, or change", () => {
    const { run, output, sudoCalls } = refusedRun();
    expect(landoExitCodes(run.output)[0], output).not.toBe(0);
    expect(output).toContain("RootOwnedLandoFilesError");
    expect(output).not.toContain(CONSENT);
    expect(sudoCalls).toBe(0);
  });

  test("the refusal lists only the hard link, with a command that removes it and never one that changes its owner", () => {
    const { output } = refusedRun();
    const { hardLink, dir, file } = layout("hard-link");
    expect(output).toContain(`rm -f '${hardLink}'`);
    expect(output).not.toContain("chown");
    expect(output).not.toContain(dir);
    expect(output).not.toContain(file);
  });

  test("after the user removes the hard link, setup gives the rest back and trusts the CA with one sudo prompt", () => {
    const run = runs.terminal("hard-link");
    const { dir, dirFile, file } = layout("hard-link");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(run.prompts).toBe(1);
    givenBack(run, [dir, dirFile, file]);
    expect(run.systemTrust.rootTrusted).toBe(true);
  });

  test("the hard link's target outside Lando's roots, the symlink, and /etc/shadow keep their owners and modes", () => {
    const { hardLinkTarget, symlink } = layout("hard-link");
    unchanged(runs.terminal("hard-link"), [hardLinkTarget, symlink, "/etc/shadow"]);
  });

  test("with no data root yet, setup still gives a root-owned cache file back after one sudo prompt", () => {
    const run = runs.terminal("no-data-root");
    expect(landoExitCode(run.output), run.output).toBe(0);
    expect(run.prompts).toBe(1);
    givenBack(run, [layout("no-data-root").file]);
  });

  test("with no data root yet, setup leaves it absent or creates it as landotest's", () => {
    const run = runs.terminal("no-data-root");
    const { root, data } = scenarioRoots("no-data-root");
    const owner = run.pathsBefore[root];
    if (owner === null || owner === undefined) throw new Error("no-data-root has no scenario root.");
    const created = run.paths[data] ?? null;
    const observed = created === null ? null : { kind: created.kind, uid: created.uid, gid: created.gid };
    expect([null, { kind: "directory", uid: owner.uid, gid: owner.gid }]).toContainEqual(observed);
  });

  test("doctor --fix in a terminal asks once, shows sudo's prompt once, and has the walker give the file back", () => {
    const run = runs.terminal("doctor-fix");
    const { file } = layout("doctor-fix");
    expect(run.prompts).toBe(1);
    expect(rootCommands(run).map(walkerCall)).toEqual([expectedWalkerCall(run, [file])]);
    givenBack(run, [file]);
  });

  test("doctor --fix in a terminal reports the root-owned entries recovered", () => {
    const report = decodeDoctorReport(runs.printedEnvelope("doctor-fix").result);
    const checks = report.checks.filter(({ section }) => section === "lando-roots");
    expect(checks.map(({ status, context }) => ({ status, fixOutcome: context.fixOutcome }))).toEqual([
      { status: "pass", fixOutcome: "recovered" },
    ]);
  });

  test("doctor --fix without a terminal changes nothing and reports skipped-manual with the command to run", () => {
    const { run, envelope } = runs.detached("doctor-no-terminal");
    const { file } = layout("doctor-no-terminal");
    const check = decodeDoctorReport(envelope.result).checks.find(({ section }) => section === "lando-roots");
    expect(check?.status, run.stdout).toBe("fail");
    expect(check?.context.fixOutcome).toBe("skipped-manual");
    expect(check?.solutions.some(({ command }) => command?.includes(file) === true)).toBe(true);
    expect(run.sudoCalls).toEqual([]);
    unchanged(run, [file]);
  });
});
