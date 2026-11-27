import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostChangeStaleError } from "@lando/sdk/errors";
import { type HostChange, HostChangeId } from "@lando/sdk/schema";
import type { HostChangeStepRunner, PrivilegeSession } from "@lando/sdk/services";
import { Effect, Exit } from "effect";
import { makeHostChangeApplier } from "../../src/host-changes/apply";
import * as ProcessRunnerLayer from "../../src/services/process-runner";
import { proposal } from "./fixtures";

const recordingSession = () => {
  const calls: Array<{ readonly argv: ReadonlyArray<string>; readonly stdin?: Uint8Array }> = [];
  const session: PrivilegeSession = {
    transport: "cached",
    elevate: (argv, options) =>
      Effect.sync(() => {
        calls.push({ argv, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
        return { exitCode: 0, stdout: "", stderr: "token=hunter2" };
      }),
  };
  return { session, calls };
};

const id = HostChangeId.make("provider-test:enable-thing");
const errorTag = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? Reflect.get(Object(exit.cause.reasons[0].error), "_tag")
    : undefined;

describe("makeHostChangeApplier", () => {
  test("runs a declared step through the session once per run, with redacted output", async () => {
    const { session, calls } = recordingSession();
    let applies = 0;
    let stderr = "";
    const run = makeHostChangeApplier({
      proposals: [
        proposal({}, (steps) =>
          steps.run("enable").pipe(
            Effect.map((result) => {
              applies += 1;
              stderr = result.stderr;
              return { changed: true };
            }),
          ),
        ),
      ],
      approved: new Set([id]),
      session,
      redact: (text) => text.replace("hunter2", "[redacted]"),
    });

    const first = await Effect.runPromise(run.applier.apply(id));
    const second = await Effect.runPromise(run.applier.apply(id));

    expect([first, second]).toEqual([
      { id, outcome: "applied" },
      { id, outcome: "applied" },
    ]);
    expect(applies).toBe(1);
    expect(calls.map(({ argv }) => argv)).toEqual([["/usr/bin/thing", "enable"]]);
    expect(stderr).toBe("token=[redacted]");
    expect(run.outcomes()).toEqual([{ id, outcome: "applied" }]);
  });

  test("an unapproved change is declined without running", async () => {
    const { session, calls } = recordingSession();
    const run = makeHostChangeApplier({
      proposals: [proposal()],
      approved: new Set(),
      session,
      redact: String,
    });

    expect(run.applier.approved(id)).toBeUndefined();
    expect(await Effect.runPromise(run.applier.apply(id))).toEqual({ id, outcome: "declined" });
    expect(calls).toEqual([]);
  });

  test.each([
    ["an undeclared step", (steps: HostChangeStepRunner) => steps.run("other")],
    [
      "input on a step that declares none",
      (steps: HostChangeStepRunner) => steps.run("enable", { stdin: new Uint8Array([1]) }),
    ],
  ] as const)("refuses %s without running it", async (_name, misuse) => {
    const { session, calls } = recordingSession();
    const run = makeHostChangeApplier({
      proposals: [proposal({}, (steps) => misuse(steps).pipe(Effect.as({ changed: true })))],
      approved: new Set([id]),
      session,
      redact: String,
    });

    expect(errorTag(await Effect.runPromiseExit(run.applier.apply(id)))).toBe("HostChangeContractError");
    expect(calls).toEqual([]);
  });

  test("checks piped input against the digest the plan declared", async () => {
    const input = new TextEncoder().encode("Delegate=yes\n");
    const digest = createHash("sha256").update(input).digest("hex");
    const steps: HostChange["steps"] = [
      {
        id: "enable",
        summary: "write",
        argv: ["/usr/bin/tee", "/etc/x"],
        privileged: true,
        when: "always",
        stdin: { summary: "drop-in", sha256: digest },
      },
    ];
    const attempt = async (bytes: Uint8Array) => {
      const { session, calls } = recordingSession();
      const run = makeHostChangeApplier({
        proposals: [
          proposal({ steps }, (runner) =>
            runner.run("enable", { stdin: bytes }).pipe(Effect.as({ changed: true })),
          ),
        ],
        approved: new Set([id]),
        session,
        redact: String,
      });
      return { exit: await Effect.runPromiseExit(run.applier.apply(id)), calls };
    };

    const matching = await attempt(input);
    expect(matching.exit).toEqual(Exit.succeed({ id, outcome: "applied", inputs: { enable: digest } }));
    expect(matching.calls[0]?.stdin).toEqual(input);
    const tampered = await attempt(new TextEncoder().encode("Delegate=no\n"));
    expect(errorTag(tampered.exit)).toBe("HostChangeContractError");
    expect(tampered.calls).toEqual([]);
  });

  const pipingToRoot = async (
    stdin: NonNullable<HostChange["steps"][number]["stdin"]>,
    bytes: Uint8Array,
  ) => {
    const { session, calls } = recordingSession();
    const steps: HostChange["steps"] = [
      {
        id: "enable",
        summary: "write",
        argv: ["/usr/bin/tee", "/etc/x"],
        privileged: true,
        when: "always",
        stdin,
      },
    ];
    const run = makeHostChangeApplier({
      proposals: [
        proposal({ steps }, (runner) =>
          runner.run("enable", { stdin: bytes }).pipe(Effect.as({ changed: true })),
        ),
      ],
      approved: new Set([id]),
      session,
      redact: String,
    });
    return { exit: await Effect.runPromiseExit(run.applier.apply(id)), calls };
  };

  test("input bound at apply runs once its change checked it, and the outcome records what root read", async () => {
    const bytes = new TextEncoder().encode("-----BEGIN CERTIFICATE-----\n");

    const { exit, calls } = await pipingToRoot(
      { summary: "the root", boundAt: "apply", verifiedBy: "one PEM certificate" },
      bytes,
    );

    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(exit).toEqual(Exit.succeed({ id, outcome: "applied", inputs: { enable: digest } }));
    expect(calls[0]?.stdin).toEqual(bytes);
  });

  test("refuses to pipe input to root that the plan never bound", async () => {
    const { exit, calls } = await pipingToRoot({ summary: "the file" }, new Uint8Array([1]));

    expect(errorTag(exit)).toBe("HostChangeContractError");
    expect(calls).toEqual([]);
  });

  test("reports a stale change and an approved change no stage applied", async () => {
    const other = HostChangeId.make("provider-test:other");
    const stale = new HostChangeStaleError({
      changeId: id,
      reason: "range taken",
      message: "changed",
      remediation: "Rerun `lando setup`.",
    });
    const run = makeHostChangeApplier({
      proposals: [proposal({}, () => Effect.fail(stale)), proposal({ id: other })],
      approved: new Set([id, other]),
      session: recordingSession().session,
      redact: String,
    });

    expect(errorTag(await Effect.runPromiseExit(run.applier.apply(id)))).toBe("HostChangeStaleError");
    expect(run.outcomes()).toEqual([
      { id, outcome: "stale", detail: "range taken" },
      { id: other, outcome: "skipped" },
    ]);
  });
});

// Linux resolves `/dev/stdin` through `/proc/self/fd/0`, which reopens the descriptor's target
// instead of duplicating it, and a socket cannot be reopened.
describe.skipIf(process.platform !== "linux")("steps that read input through the real process runner", () => {
  const input = new TextEncoder().encode("[Service]\nDelegate=cpu cpuset io memory pids\n");
  const runStep = async (argv: readonly [string, ...string[]]) => {
    const ran: Array<{ readonly exitCode: number; readonly stderr: string }> = [];
    const stepId = HostChangeId.make("provider-test:write");
    const run = makeHostChangeApplier({
      proposals: [
        proposal(
          {
            id: stepId,
            manual: "Write the file yourself.",
            steps: [
              {
                id: "write",
                summary: "write",
                argv,
                privileged: false,
                stdin: { summary: "the file" },
                when: "always",
              },
            ],
          },
          (runner) =>
            runner.run("write", { stdin: input }).pipe(
              Effect.map((result) => {
                ran.push({ exitCode: result.exitCode, stderr: result.stderr });
                return { changed: true };
              }),
            ),
        ),
      ],
      approved: new Set([stepId]),
      runner: ProcessRunnerLayer.service,
      redact: String,
    });
    await Effect.runPromise(run.applier.apply(stepId));
    return ran;
  };

  test("a step that opens /dev/stdin by path fails: Lando hands the child a socket, not a file", async () => {
    // This is why plan validation rejects `/dev/stdin` in any step: `install ... /dev/stdin <file>`
    // fails the same way, with sudo or without.
    const dir = await mkdtemp(join(tmpdir(), "lando-stdin-"));
    try {
      const [result] = await runStep(["/bin/sh", "-c", 'cat /dev/stdin > "$0"', join(dir, "by-path")]);
      expect(result?.exitCode).not.toBe(0);
      expect(result?.stderr).toContain("No such device or address");
      expect(await readFile(join(dir, "by-path"), "utf8")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a step that reads its descriptor 0, as tee does, writes exactly the planned input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-stdin-"));
    try {
      const [result] = await runStep(["/usr/bin/tee", join(dir, "fd0")]);
      expect(result?.exitCode).toBe(0);
      expect(await readFile(join(dir, "fd0"), "utf8")).toBe(new TextDecoder().decode(input));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
