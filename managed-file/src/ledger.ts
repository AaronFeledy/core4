import { ManagedFileError } from "@lando/sdk/errors";
import { FileFormat } from "@lando/sdk/schema";
import type { StateWrite } from "@lando/sdk/services";
import { defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";
import { Effect, Schema } from "effect";

const LedgerEntrySchema = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  path: Schema.String,
  mode: Schema.Literals(["file", "block", "keys"]),
  format: FileFormat,
  marker: Schema.String,
  lastWrittenChecksum: Schema.String,
  sourceHash: Schema.String,
  state: Schema.Literals(["managed", "adopted"]),
  base: Schema.optionalKey(Schema.String),
  backup: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type LedgerEntry = typeof LedgerEntrySchema.Type;
export const LedgerStateSchema = Schema.Struct({ entries: Schema.Array(LedgerEntrySchema) });
export type LedgerState = typeof LedgerStateSchema.Type;
export const LEDGER_VERSION = 1;

export const ledgerTransitions = defineTransitions<"absent" | LedgerEntry["state"]>()({
  manage: { from: ["absent", "managed"], to: "managed", settledIn: ["adopted"] },
  "detect-adoption": { from: ["absent", "managed"], to: "adopted", settledIn: ["adopted"] },
  adopt: { from: ["managed"], to: "adopted", settledIn: ["adopted", "absent"] },
  release: { from: ["managed"], to: "adopted", settledIn: ["adopted", "absent"] },
  remove: { from: ["managed"], to: "absent", settledIn: ["absent"] },
});

type LedgerCommand =
  | { readonly operation: "manage" | "detect-adoption"; readonly body: Omit<LedgerEntry, "state"> }
  | { readonly operation: "adopt" | "release"; readonly updatedAt: string }
  | { readonly operation: "remove" };

export const planLedgerWrite = (
  command: LedgerCommand,
  previous: LedgerEntry | undefined,
): Effect.Effect<LedgerEntry | undefined, ManagedFileError> => {
  const verdict = ledgerTransitions.step(command.operation, previous?.state ?? "absent");
  switch (verdict._tag) {
    case "Settled":
      return Effect.succeed(previous);
    case "Illegal":
      return Effect.fail(
        new ManagedFileError({
          reason: "conflict",
          operation:
            command.operation === "manage" || command.operation === "detect-adoption"
              ? "apply"
              : command.operation,
          remediation: illegalTransitionMessage("Managed-file ledger entry", command.operation, verdict),
        }),
      );
    case "Advance": {
      if (verdict.to === "absent") return Effect.succeed(undefined);
      switch (command.operation) {
        case "manage":
        case "detect-adoption":
          return Effect.succeed({ ...command.body, state: verdict.to });
        case "adopt":
        case "release":
          return Effect.succeed(
            previous === undefined
              ? undefined
              : {
                  ...previous,
                  state: verdict.to,
                  updatedAt: command.updatedAt,
                },
          );
        case "remove":
          return Effect.succeed(undefined);
        default:
          return command satisfies never;
      }
    }
    default:
      return verdict satisfies never;
  }
};

/** A ledger mutation that leaves every entry in place keeps the file untouched. */
export const planLedgerStateWrite = <A>(
  current: ReadonlyArray<LedgerEntry>,
  [result, next]: readonly [A, ReadonlyArray<LedgerEntry>],
): StateWrite<LedgerState, A> =>
  next.length === current.length && next.every((entry, index) => entry === current[index])
    ? { _tag: "Keep", result }
    : { _tag: "Set", value: { entries: next }, result };
