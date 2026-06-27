import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";

import {
  ContractFailure,
  type DoctorCheckContractHarness,
  DoctorCheckError,
  type DoctorCheckResult,
  makeDoctorCheckContractSuite,
  runDoctorCheckContractSuite,
} from "@lando/sdk/test";

// Reference check: reports one warning with context + a manual solution.
const manualWarningCheck = {
  id: "ssl-cert",
  run: (): Effect.Effect<DoctorCheckResult, DoctorCheckError> =>
    Effect.succeed({
      id: "ssl-cert",
      issues: [
        {
          severity: "warning" as const,
          context: { ca: "lando", trusted: "false" },
          solutionKind: "manual" as const,
          solution: "Re-run lando setup to trust the Lando CA.",
        },
      ],
    }),
};

describe("Doctor check contract", () => {
  test("a reference check with a manual solution passes the contract", async () => {
    const harness: DoctorCheckContractHarness = {
      name: "ssl-cert",
      check: manualWarningCheck,
      expectedIssue: { severity: "warning", contextKey: "ca", solutionKind: "manual" },
    };
    const exit = await Effect.runPromiseExit(runDoctorCheckContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("a check proves read-only default vs --fix executes the automatic solution", async () => {
    const stateRef = await Effect.runPromise(Ref.make("clean"));
    const fixedRef = await Effect.runPromise(Ref.make(false));

    const autoFixCheck = {
      id: "daemon-socket",
      run: ({ fix }: { fix: boolean }): Effect.Effect<DoctorCheckResult, DoctorCheckError> =>
        Effect.gen(function* () {
          if (fix) {
            yield* Ref.set(stateRef, "fixed");
            yield* Ref.set(fixedRef, true);
          }
          return {
            id: "daemon-socket",
            issues: [
              {
                severity: "error" as const,
                context: { socket: "missing" },
                solutionKind: "automatic" as const,
                solution: "Recreate the daemon socket.",
                command: "lando doctor --fix",
              },
            ],
          };
        }),
    };

    const harness: DoctorCheckContractHarness = {
      name: "daemon-socket",
      check: autoFixCheck,
      expectedIssue: { severity: "error", solutionKind: "automatic" },
      readOnlyProbe: {
        snapshot: Ref.get(stateRef),
        assertUnchanged: (before) => Effect.map(Ref.get(stateRef), (now) => now === before),
      },
      fixProbe: Ref.get(fixedRef),
    };
    const exit = await Effect.runPromiseExit(runDoctorCheckContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("shell-runner + redacted-transcript probes pass when supplied", async () => {
    const exit = await Effect.runPromiseExit(
      runDoctorCheckContractSuite({
        check: manualWarningCheck,
        shellRunnerProbe: Effect.succeed(["$ openssl x509 -noout -subject", "subject=CN=app.lndo.site"]),
        secretValue: "super-secret-token",
        redactedTranscriptProbe: Effect.succeed("Authorization: Bearer [redacted]"),
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("an automatic issue without a command fails the contract", async () => {
    const bad = {
      id: "bad",
      run: (): Effect.Effect<DoctorCheckResult, DoctorCheckError> =>
        Effect.succeed({
          id: "bad",
          issues: [
            {
              severity: "error" as const,
              context: {},
              solutionKind: "automatic" as const,
              solution: "Fix it.",
            },
          ],
        }),
    };
    const exit = await Effect.runPromiseExit(runDoctorCheckContractSuite({ check: bad }));
    expect(exit._tag).toBe("Failure");
  });

  test("a redacted-transcript probe that leaks the secret fails the contract", async () => {
    const exit = await Effect.runPromiseExit(
      runDoctorCheckContractSuite({
        check: manualWarningCheck,
        secretValue: "leaked-token",
        redactedTranscriptProbe: Effect.succeed("Authorization: Bearer leaked-token"),
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("makeDoctorCheckContractSuite is an alias", () => {
    expect(makeDoctorCheckContractSuite).toBe(runDoctorCheckContractSuite);
  });

  test("DoctorCheckError and ContractFailure are exported", () => {
    expect(DoctorCheckError).toBeDefined();
    expect(ContractFailure).toBeDefined();
  });
});
