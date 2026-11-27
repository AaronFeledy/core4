import { describe, expect, test } from "bun:test";

import { HostChangeContractError } from "@lando/sdk/errors";
import { HostChangeId, type HostChangeStep } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";
import { previewApprovals, validateHostChangePlan } from "../../src/host-changes/plan";
import { change, proposal } from "./fixtures";

const context = { setupFlags: new Set(["enable-thing"]) };
const DIGEST = "0".repeat(64);

const writing = (stdin: NonNullable<HostChangeStep["stdin"]>) =>
  proposal({
    manual: "Write the file yourself.",
    steps: [
      {
        id: "write",
        summary: "write",
        argv: ["/usr/bin/tee", "/etc/x"],
        privileged: true,
        stdin,
        when: "always",
      },
    ],
  });

const contractDetail = (exit: Exit.Exit<unknown, unknown>): string | undefined =>
  Exit.isFailure(exit) &&
  exit.cause.reasons[0]?._tag === "Fail" &&
  exit.cause.reasons[0].error instanceof HostChangeContractError
    ? exit.cause.reasons[0].error.detail
    : undefined;

describe("validateHostChangePlan", () => {
  test("accepts a well-formed plan unchanged", () => {
    const plan = [proposal(), proposal({ id: HostChangeId.make("provider-test:other") })];

    expect(Effect.runSync(validateHostChangePlan(plan, context))).toBe(plan);
  });

  test.each([
    ["input bound by its planned digest", { summary: "the file", sha256: DIGEST }],
    [
      "input bound at apply by a described check",
      { summary: "the file", boundAt: "apply", verifiedBy: "one PEM" },
    ],
  ] as const)("accepts %s", (_name, stdin) => {
    const plan = [writing(stdin)];

    expect(Effect.runSync(validateHostChangePlan(plan, context))).toBe(plan);
  });

  test.each([
    ["an id planned twice", [proposal(), proposal()], "its id is planned twice"],
    [
      "an id outside its owner's name",
      [proposal({ owner: "@lando/ca-mkcert" })],
      'its id must start with "ca-mkcert:"',
    ],
    [
      "a privileged step with a relative program",
      [proposal({ steps: [{ id: "a", summary: "a", argv: ["thing"], privileged: true, when: "always" }] })],
      "privileged step a must name an absolute program",
    ],
    [
      "a privileged step with an environment",
      [
        proposal({
          steps: [
            { id: "a", summary: "a", argv: ["/bin/a"], env: { A: "1" }, privileged: true, when: "always" },
          ],
        }),
      ],
      "privileged step a cannot set an environment",
    ],
    [
      "a step declared twice",
      [
        proposal({
          steps: [
            { id: "a", summary: "a", argv: ["/bin/a"], privileged: true, when: "always" },
            { id: "a", summary: "a", argv: ["/bin/b"], privileged: true, when: "always" },
          ],
        }),
      ],
      "step a is declared twice",
    ],
    [
      "an opt-in flag on a standard change",
      [proposal({ optInFlag: "enable-thing" })],
      "only a separately approved change may name an opt-in flag",
    ],
    [
      "an opt-in flag the run does not declare",
      [proposal({ consent: "separate", optInFlag: "enable-other" })],
      "--enable-other is not a setup flag of this run",
    ],
    [
      "a separate change without the flag that approves it",
      [proposal({ consent: "separate", requirement: "recommended" })],
      "a separately approved change must name the opt-in flag that approves it",
    ],
    [
      "a privileged step reading input nothing binds",
      [writing({ summary: "the file" })],
      "privileged step write reads input that neither a planned digest nor an apply-time check binds",
    ],
    [
      "input bound at apply without saying how it is checked",
      [writing({ summary: "the file", boundAt: "apply" })],
      "privileged step write binds its input at apply without saying how it is checked",
    ],
    [
      "input bound both at plan time and at apply",
      [writing({ summary: "the file", sha256: DIGEST, boundAt: "apply", verifiedBy: "a check" })],
      "privileged step write binds its input both at plan time and at apply",
    ],
    [
      "a required change only a terminal can approve",
      [proposal({ consent: "interactive-only" })],
      "a change only a terminal can approve cannot be required",
    ],
    [
      "a step that opens its input by path",
      [
        proposal({
          manual: "Write the file yourself.",
          steps: [
            {
              id: "write",
              summary: "write",
              argv: ["/usr/bin/install", "-m", "0644", "/dev/stdin", "/etc/x"],
              privileged: true,
              stdin: { summary: "the file", sha256: DIGEST },
              when: "always",
            },
          ],
        }),
      ],
      "step write opens its input by path; read descriptor 0 instead, as `tee <file>` does",
    ],
    [
      "a change whose step reads input but that says nothing about doing it by hand",
      [
        proposal({
          steps: [
            {
              id: "write",
              summary: "write",
              argv: ["/usr/bin/tee", "/etc/x"],
              privileged: true,
              stdin: { summary: "the file", sha256: DIGEST },
              when: "always",
            },
          ],
        }),
      ],
      "a change whose step reads input must say how to make it by hand",
    ],
  ] as const)("rejects %s", (_name, plan, detail) => {
    expect(contractDetail(Effect.runSyncExit(validateHostChangePlan(plan, context)))).toBe(detail);
  });
});

describe("previewApprovals", () => {
  const standard = change();
  const flagged = change({
    id: HostChangeId.make("provider-test:linger"),
    consent: "separate",
    optInFlag: "enable-thing",
  });
  const optional = change({
    id: HostChangeId.make("provider-test:tuning"),
    consent: "separate",
    optInFlag: "enable-thing",
    requirement: "recommended",
  });
  const terminalOnly = change({
    id: HostChangeId.make("provider-test:takeover"),
    consent: "interactive-only",
    requirement: "recommended",
  });

  test.each([
    [
      "no flags, in a terminal",
      { yes: false, optInFlags: new Set<string>(), canAsk: true },
      ["will-ask", "will-ask", "will-ask", "will-ask"],
    ],
    [
      "no flags, without a terminal",
      { yes: false, optInFlags: new Set<string>(), canAsk: false },
      ["blocked", "blocked", "will-skip", "not-offered"],
    ],
    [
      "--yes, in a terminal",
      { yes: true, optInFlags: new Set<string>(), canAsk: true },
      ["approved", "blocked", "will-skip", "not-offered"],
    ],
    [
      "--yes and the opt-in flag",
      { yes: true, optInFlags: new Set(["enable-thing"]), canAsk: false },
      ["approved", "approved", "approved", "not-offered"],
    ],
  ] as const)("with %s says what this run does", (_name, inputs, expected) => {
    expect(
      previewApprovals([standard, flagged, optional, terminalOnly], inputs).map(({ approval }) => approval),
    ).toEqual([...expected]);
  });

  test("names the flags that approve each change, whatever this run was given", () => {
    const inputs = { yes: true, optInFlags: new Set(["enable-thing"]), canAsk: true };

    expect(
      previewApprovals([standard, flagged, terminalOnly], inputs).map(({ approvedBy }) => approvedBy),
    ).toEqual([["--yes"], ["--enable-thing"], []]);
  });
});
