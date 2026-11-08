import { internalErrorRemediation } from "@lando/sdk/command-result";
import { Effect, Schema } from "effect";

export class ShellFailure extends Schema.TaggedError<ShellFailure>()("ShellFailure", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

const tagged = () =>
  Object.assign(new ShellFailure({ message: "operation refused", remediation: "Retry with valid input." }), {
    stack: "ShellFailure: operation refused\n    at <fixture>",
  });

const defect = (message: string) =>
  Object.assign(new Error(message), { stack: `Error: ${message}\n    at <fixture>` });

export const shellFailureCases = [
  {
    kind: "tagged",
    effect: () => Effect.fail(tagged()),
    failureTag: "ShellFailure",
    text: "operation refused\n  ↳ Retry with valid input.\ncode: ShellFailure",
    error: { _tag: "ShellFailure", message: "operation refused", remediation: "Retry with valid input." },
    rejectionName: "ShellFailure",
    rejectionMessage: "operation refused",
    rejectionText: "ShellFailure: operation refused",
    rejectionJson: {
      _tag: "ShellFailure",
      message: "operation refused",
      remediation: "Retry with valid input.",
    },
    causeText: "ShellFailure: operation refused\n    at <fixture>",
    rejectionCause: {
      _id: "Cause",
      failures: [
        {
          _tag: "Fail",
          error: {
            message: "operation refused",
            remediation: "Retry with valid input.",
            _tag: "ShellFailure",
          },
        },
      ],
    },
  },
  {
    kind: "defect",
    effect: () => Effect.die(defect("unexpected defect")),
    failureTag: "LandoInternalError",
    text: `unexpected defect\n  ↳ ${internalErrorRemediation}\ncode: LandoInternalError`,
    error: {
      _tag: "LandoInternalError",
      message: "unexpected defect",
      remediation: internalErrorRemediation,
    },
    rejectionName: "Error",
    rejectionMessage: "unexpected defect",
    rejectionText: "Error: unexpected defect",
    rejectionJson: {},
    causeText: "Error: unexpected defect\n    at <fixture>",
    rejectionCause: { _id: "Cause", failures: [{ _tag: "Die", defect: {} }] },
  },
  {
    kind: "interrupt",
    effect: () => Effect.interrupt,
    failureTag: "Interrupted",
    // CLI projection is distinct from the preserved Effect rejection below.
    text: "Command interrupted.\n  ↳ Run the command again when ready.\ncode: CommandInterruptedError",
    error: {
      _tag: "CommandInterruptedError",
      message: "Command interrupted.",
      remediation: "Run the command again when ready.",
    },
    rejectionName: "Error",
    rejectionMessage: "All fibers interrupted without error",
    rejectionText: "Error: All fibers interrupted without error",
    rejectionJson: {},
    causeText:
      "InterruptError: All fibers interrupted without error {\n  [cause]: InterruptCause: The fiber was interrupted by:\n      at fiber (#<id>)\n}",
    rejectionCause: {
      _id: "Cause",
      failures: [{ _tag: "Interrupt", fiberId: "<id>" }],
    },
  },
  {
    kind: "combined",
    // A real failing finalizer retains both failures, rather than racing two fail-fast fibers.
    effect: () => Effect.fail(tagged()).pipe(Effect.ensuring(Effect.die(defect("cleanup defect")))),
    failureTag: "ShellFailure",
    text: "ShellFailure: operation refused\n    at <fixture>\nError: cleanup defect\n    at <fixture>\ncode: Error",
    error: {
      _tag: "Error",
      message: "ShellFailure: operation refused\n    at <fixture>\nError: cleanup defect\n    at <fixture>",
    },
    rejectionName: "ShellFailure",
    rejectionMessage: "operation refused",
    rejectionText: "ShellFailure: operation refused",
    rejectionJson: {
      _tag: "ShellFailure",
      message: "operation refused",
      remediation: "Retry with valid input.",
    },
    causeText: "ShellFailure: operation refused\n    at <fixture>\nError: cleanup defect\n    at <fixture>",
    rejectionCause: {
      _id: "Cause",
      failures: [
        {
          _tag: "Fail",
          error: {
            message: "operation refused",
            remediation: "Retry with valid input.",
            _tag: "ShellFailure",
          },
        },
        { _tag: "Die", defect: {} },
      ],
    },
  },
] as const;

export const normalizeRejectionJson = (error: unknown): unknown =>
  JSON.parse(
    JSON.stringify(error, (key, value: unknown) => {
      if (key === "fiberId" && typeof value === "number") return "<id>";
      return value;
    }),
  );
