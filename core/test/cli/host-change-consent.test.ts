import { describe, expect, test } from "bun:test";
import { previewApprovals } from "@lando/engine/host-changes/plan";
import { HostChangeConsentRequiredError, HostChangeDeclinedError } from "@lando/sdk/errors";
import { type HostChange, HostChangeId } from "@lando/sdk/schema";
import type { InteractionServiceShape } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { decideHostChangeConsent } from "../../src/cli/host-changes/consent";

const hostChange = (id: string, overrides: Partial<HostChange> = {}): HostChange => ({
  id: HostChangeId.make(`provider-test:${id}`),
  owner: "@lando/provider-test",
  stage: "provider",
  summary: `Change ${id}`,
  reason: `The runtime needs ${id}.`,
  consent: "standard",
  persistent: false,
  requirement: "required",
  steps: [{ id: "run", summary: "run", argv: ["/usr/bin/true", id], privileged: true, when: "always" }],
  undo: { _tag: "none", detail: "Nothing to undo." },
  ...overrides,
});

const uidmap = hostChange("uidmap");
const tuning = hostChange("tuning", { requirement: "recommended" });
const linger = hostChange("linger", {
  consent: "separate",
  optInFlag: "enable-linger",
  persistent: true,
  requirement: "recommended",
});
const requiredLinger = hostChange("linger", {
  consent: "separate",
  optInFlag: "enable-linger",
  requirement: "required",
});
const takeover = hostChange("takeover", { consent: "interactive-only", requirement: "recommended" });

const answering = (answers: Record<string, boolean>) => {
  const asked: string[] = [];
  const questions: string[] = [];
  const interaction: InteractionServiceShape = {
    id: "test",
    isInteractive: Effect.succeed(true),
    prompt: () => Effect.die("unused"),
    promptAll: () => Effect.die("unused"),
    confirm: (spec) =>
      Effect.sync(() => {
        const name = spec.name ?? "";
        asked.push(name);
        questions.push(spec.message);
        return answers[name] ?? false;
      }),
    select: () => Effect.die("unused"),
    secret: () => Effect.die("unused"),
  };
  return { interaction, asked, questions };
};

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const found = Cause.findErrorOption(exit.cause);
  return found._tag === "Some" ? found.value : undefined;
};

const none = new Set<string>();

describe("decideHostChangeConsent", () => {
  test("--yes approves standard changes but neither separate nor terminal-only ones", async () => {
    const result = await Effect.runPromise(
      decideHostChangeConsent([uidmap, linger, takeover], {
        command: "setup",
        yes: true,
        optInFlags: none,
        interaction: undefined,
      }),
    );

    expect([...result.approved]).toEqual([uidmap.id]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("--enable-linger");
  });

  test("the opt-in flag approves its separate change without asking", async () => {
    const { interaction, asked } = answering({});
    const result = await Effect.runPromise(
      decideHostChangeConsent([linger], {
        command: "setup",
        yes: false,
        optInFlags: new Set(["enable-linger"]),
        interaction,
      }),
    );

    expect([...result.approved]).toEqual([linger.id]);
    expect(asked).toEqual([]);
  });

  test("a run that cannot ask fails before any prompt, naming every flag it needs", async () => {
    const exit = await Effect.runPromiseExit(
      decideHostChangeConsent([uidmap, requiredLinger, tuning], {
        command: "setup",
        yes: false,
        optInFlags: none,
        interaction: undefined,
      }),
    );

    const error = failure(exit);
    expect(error).toBeInstanceOf(HostChangeConsentRequiredError);
    expect(error instanceof HostChangeConsentRequiredError ? error.flags : []).toEqual([
      "--yes",
      "--enable-linger",
    ]);
    expect(error instanceof HostChangeConsentRequiredError ? error.changeIds : []).toEqual([
      uidmap.id,
      requiredLinger.id,
    ]);
    // One command-line fragment a person can paste.
    expect(error instanceof HostChangeConsentRequiredError ? error.remediation : "").toContain(
      "then rerun with `--yes --enable-linger`, or",
    );
  });

  test("a separate change missing alone names only its own flag, never --yes", async () => {
    const exit = await Effect.runPromiseExit(
      decideHostChangeConsent([requiredLinger], {
        command: "setup",
        yes: true,
        optInFlags: none,
        interaction: undefined,
      }),
    );

    const error = failure(exit);
    expect(error instanceof HostChangeConsentRequiredError ? error.flags : []).toEqual(["--enable-linger"]);
    expect(error instanceof HostChangeConsentRequiredError ? error.remediation : "").toContain(
      "then rerun with `--enable-linger`, or",
    );
  });

  test("asks once for every standard change and separately for each other change", async () => {
    const { interaction, asked } = answering({
      "setup-host-changes": true,
      "setup-host-change-provider-test-linger": false,
      "setup-host-change-provider-test-takeover": true,
    });
    const result = await Effect.runPromise(
      decideHostChangeConsent([uidmap, tuning, linger, takeover], {
        command: "setup",
        yes: false,
        optInFlags: none,
        interaction,
      }),
    );

    expect(asked).toEqual([
      "setup-host-changes",
      "setup-host-change-provider-test-linger",
      "setup-host-change-provider-test-takeover",
    ]);
    expect([...result.approved]).toEqual([uidmap.id, tuning.id, takeover.id]);
    expect(result.warnings).toHaveLength(1);
  });

  test("declining a required change fails at once", async () => {
    const { interaction, asked } = answering({ "setup-host-changes": false });
    const exit = await Effect.runPromiseExit(
      decideHostChangeConsent([uidmap, linger], {
        command: "setup",
        yes: false,
        optInFlags: none,
        interaction,
      }),
    );

    expect(failure(exit)).toBeInstanceOf(HostChangeDeclinedError);
    expect(asked).toEqual(["setup-host-changes"]);
  });

  test("declining only recommended standard changes skips them with a warning", async () => {
    const { interaction } = answering({ "setup-host-changes": false });
    const result = await Effect.runPromise(
      decideHostChangeConsent([tuning], { command: "setup", yes: false, optInFlags: none, interaction }),
    );

    expect(result.approved.size).toBe(0);
    expect(result.warnings[0]).toContain("Lando skipped this change: Change tuning.");
  });

  test("quotes summaries verbatim and never offers input that cannot be typed as a command", async () => {
    const trust = hostChange("trust", {
      summary: "Trust Lando's local CA in the system store",
      requirement: "recommended",
      manual:
        "sudo install -m 0644 '/home/dev/.local/share/mkcert/rootCA.pem' /etc/x && sudo /usr/sbin/update-ca-certificates",
      steps: [
        {
          id: "write",
          summary: "write",
          argv: ["/usr/bin/tee", "/etc/x"],
          privileged: true,
          stdin: { summary: "The local CA certificate (never its private key)" },
          when: "always",
        },
      ],
    });

    const result = await Effect.runPromise(
      decideHostChangeConsent([trust], {
        command: "setup",
        yes: false,
        optInFlags: none,
        interaction: undefined,
      }),
    );

    expect(result.warnings[0]).toContain(
      "Lando skipped this change: Trust Lando's local CA in the system store.",
    );
    expect(result.warnings[0]).toContain(`\`${trust.manual}\``);
    expect(result.warnings[0]).not.toContain("never its private key");
  });

  test("doctor asks and explains in its own words, never pointing at setup's flags or preview", async () => {
    // Given doctor asking about a required change in a terminal.
    const { interaction, asked, questions } = answering({ "doctor-host-changes": false });

    // When the user declines.
    const declined = failure(
      await Effect.runPromiseExit(
        decideHostChangeConsent([uidmap], { command: "doctor", yes: false, optInFlags: none, interaction }),
      ),
    );

    // Then the question and the failure name doctor, and only setup is offered as the alternative.
    expect(asked).toEqual(["doctor-host-changes"]);
    expect(questions[0]).toStartWith("Doctor needs to change your system:");
    expect(questions[0]).not.toContain("--dry-run");
    expect(declined).toBeInstanceOf(HostChangeDeclinedError);
    expect(Reflect.get(Object(declined), "message")).toStartWith("Doctor cannot finish without this change:");
    expect(Reflect.get(Object(declined), "remediation")).toContain(
      "Rerun `lando doctor --fix` and approve it",
    );
  });

  test("doctor without a terminal names doctor --fix in a terminal and setup, not a doctor --yes", async () => {
    const exit = await Effect.runPromiseExit(
      decideHostChangeConsent([uidmap], {
        command: "doctor",
        yes: false,
        optInFlags: none,
        interaction: undefined,
      }),
    );

    const error = failure(exit);
    expect(error).toBeInstanceOf(HostChangeConsentRequiredError);
    expect(Reflect.get(Object(error), "message")).toStartWith("Doctor needs your approval");
    expect(Reflect.get(Object(error), "remediation")).toBe(
      "Rerun `lando doctor --fix` in a terminal to approve them, or run `lando setup` with `--yes`, which makes the same changes.",
    );
  });

  describe("a required change only its own flag approves", () => {
    const runtimeDir = hostChange("linger", {
      summary: "Enable lingering for dev",
      reason:
        "The runtime cannot start without it; logging in through a session with pam_systemd also works.",
      consent: "separate",
      optInFlag: "enable-linger",
      persistent: true,
      requirement: "required",
      steps: [
        {
          id: "enable",
          summary: "enable",
          argv: ["/usr/bin/loginctl", "enable-linger", "dev"],
          privileged: true,
          when: "always",
        },
      ],
    });

    test.each([
      ["--yes without its flag", { yes: true }],
      ["a run that cannot ask", { yes: false }],
    ])(
      "%s fails before anything changes, naming the flag, the manual command, and the reason",
      async (_name, flags) => {
        const exit = await Effect.runPromiseExit(
          decideHostChangeConsent([runtimeDir], {
            command: "setup",
            ...flags,
            optInFlags: none,
            interaction: undefined,
          }),
        );

        const error = failure(exit);
        expect(error).toBeInstanceOf(HostChangeConsentRequiredError);
        const remediation = error instanceof HostChangeConsentRequiredError ? error.remediation : "";
        expect(remediation).toContain("`--enable-linger`");
        expect(remediation).toContain("`sudo /usr/bin/loginctl enable-linger dev`");
        expect(remediation).toContain("pam_systemd");
      },
    );

    test("its own question says setup cannot finish without it, and No fails at once", async () => {
      const prompts: string[] = [];
      const { interaction } = answering({});
      const recording: InteractionServiceShape = {
        ...interaction,
        confirm: (spec) =>
          Effect.sync(() => {
            prompts.push(spec.message);
            return false;
          }),
      };

      const exit = await Effect.runPromiseExit(
        decideHostChangeConsent([runtimeDir], {
          command: "setup",
          yes: false,
          optInFlags: none,
          interaction: recording,
        }),
      );

      expect(failure(exit)).toBeInstanceOf(HostChangeDeclinedError);
      expect(prompts[0]).toContain("The runtime cannot start without it");
      expect(prompts[0]).toContain("Setup cannot finish without it.");
      const declined = failure(exit);
      expect(declined instanceof HostChangeDeclinedError ? declined.remediation : "").toContain(
        "--enable-linger",
      );
    });

    test("its flag approves it without asking", async () => {
      const result = await Effect.runPromise(
        decideHostChangeConsent([runtimeDir], {
          command: "setup",
          yes: true,
          optInFlags: new Set(["enable-linger"]),
          interaction: undefined,
        }),
      );

      expect([...result.approved]).toEqual([runtimeDir.id]);
    });
  });
});

describe("the dry-run preview and the real run decide alike", () => {
  type Real = "asked" | "approved" | "not-approved";
  const flag = "enable-thing";
  const realRun = async (
    candidate: HostChange,
    inputs: {
      readonly yes: boolean;
      readonly optInFlags: ReadonlySet<string>;
      readonly interactive: boolean;
    },
  ): Promise<Real> => {
    // Every question is answered no, so only an approval made without asking counts.
    const { interaction, asked } = answering({});
    const exit = await Effect.runPromiseExit(
      decideHostChangeConsent([candidate], {
        command: "setup",
        yes: inputs.yes,
        optInFlags: inputs.optInFlags,
        interaction: inputs.interactive ? interaction : undefined,
      }),
    );
    if (asked.length > 0) return "asked";
    return Exit.isSuccess(exit) && exit.value.approved.has(candidate.id) ? "approved" : "not-approved";
  };

  const failsForConsent = async (
    candidate: HostChange,
    inputs: {
      readonly yes: boolean;
      readonly optInFlags: ReadonlySet<string>;
      readonly interactive: boolean;
    },
  ): Promise<boolean> => {
    const { interaction } = answering({});
    const exit = await Effect.runPromiseExit(
      decideHostChangeConsent([candidate], {
        command: "setup",
        yes: inputs.yes,
        optInFlags: inputs.optInFlags,
        interaction: inputs.interactive ? interaction : undefined,
      }),
    );
    return failure(exit) instanceof HostChangeConsentRequiredError;
  };

  const matrix = (["standard", "separate", "interactive-only"] as const).flatMap((consent) =>
    (["required", "recommended"] as const).flatMap((requirement) =>
      (consent === "separate" ? (["present", "given"] as const) : (["absent"] as const)).flatMap((optIn) =>
        [false, true].flatMap((yes) =>
          [false, true].map((interactive) => ({ consent, requirement, optIn, yes, interactive })),
        ),
      ),
    ),
  );

  test.each(matrix)(
    "$consent, $requirement, opt-in flag $optIn, --yes $yes, terminal $interactive",
    async ({ consent, requirement, optIn, yes, interactive }) => {
      const candidate = hostChange("thing", {
        consent,
        requirement,
        ...(optIn === "absent" ? {} : { optInFlag: flag }),
      });
      const optInFlags = new Set(optIn === "given" ? [flag] : []);

      const [entry] = previewApprovals([candidate], { yes, optInFlags, canAsk: interactive });
      const real = await realRun(candidate, { yes, optInFlags, interactive });

      // The preview names exactly what the real run does.
      const approval = entry?.approval;
      const expected: Real =
        approval === "approved" ? "approved" : approval === "will-ask" ? "asked" : "not-approved";
      expect(real).toBe(expected);
      if (approval === "blocked")
        expect(await failsForConsent(candidate, { yes, optInFlags, interactive })).toBe(true);
      if (approval === "will-skip") expect(candidate.requirement).toBe("recommended");
      // The flags it names approve the change in a run that cannot ask.
      const approvedBy = entry?.approvedBy ?? [];
      const flagged = {
        yes: approvedBy.includes("--yes"),
        optInFlags: new Set(approvedBy.filter((name) => name !== "--yes").map((name) => name.slice(2))),
        interactive: false,
      };
      expect(await realRun(candidate, flagged)).toBe(approvedBy.length === 0 ? "not-approved" : "approved");
    },
  );
});
