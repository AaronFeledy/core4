import { describe, expect, test } from "bun:test";
import { HostChange, HostChangeOutcome, HostChangePlanEntry } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const linger = {
  id: "provider-lando:enable-linger",
  owner: "@lando/provider-lando",
  stage: "provider",
  summary: "Enable lingering for aaron",
  reason: "No systemd user manager runs for aaron.",
  consent: "separate",
  optInFlag: "enable-linger",
  persistent: true,
  requirement: "recommended",
  steps: [
    {
      id: "enable",
      summary: "Enable lingering",
      argv: ["/usr/bin/loginctl", "enable-linger", "aaron"],
      privileged: true,
      when: "always",
    },
    {
      id: "start-manager",
      summary: "Start the user manager",
      argv: ["/usr/bin/systemctl", "start", "--no-block", "user@1000.service"],
      privileged: true,
      when: "if-needed",
    },
  ],
  undo: {
    _tag: "steps",
    consent: "separate",
    summary: "Disable lingering for aaron",
    steps: [
      {
        id: "disable",
        summary: "Disable",
        argv: ["/usr/bin/loginctl", "disable-linger", "aaron"],
        privileged: true,
        when: "always",
      },
    ],
  },
} satisfies typeof HostChange.Encoded;

describe("HostChange", () => {
  test("round-trips a separately approved change with its exact commands and undo", () => {
    const decoded = Schema.decodeUnknownSync(HostChange)(linger);

    expect(Schema.encodeSync(HostChange)(decoded)).toEqual(linger);
    expect(
      Schema.encodeSync(HostChangePlanEntry)({
        change: decoded,
        approval: "blocked",
        approvedBy: ["--enable-linger"],
      }),
    ).toEqual({ change: linger, approval: "blocked", approvedBy: ["--enable-linger"] });
  });

  test.each([
    ["an id without an owner", { ...linger, id: "enable-linger" }],
    ["an id with capitals", { ...linger, id: "Provider-Lando:Linger" }],
    ["a change without steps", { ...linger, steps: [] }],
    ["an unknown consent class", { ...linger, consent: "implicit" }],
  ])("rejects %s", (_name, candidate) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(HostChange)(candidate))).toBe(true);
  });

  test("an outcome names one of the fixed results", () => {
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(HostChangeOutcome)({ id: linger.id, outcome: "stale", detail: "x" }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(Schema.decodeUnknownResult(HostChangeOutcome)({ id: linger.id, outcome: "failed" })),
    ).toBe(true);
  });
});
