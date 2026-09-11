import { relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import { transactionError } from "./transaction-error.ts";
import { digestOf, sameState, snapshot, statMaybe, targetPath } from "./transaction-fs.ts";
import type { Entry } from "./transaction-journal.ts";

export const TransactionRequest = Schema.Struct({
  appRoot: Schema.String,
  operations: Schema.Array(
    Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("write"),
        path: Schema.String,
        content: Schema.Union(Schema.String, Schema.Uint8ArrayFromSelf),
        secret: Schema.optional(Schema.Boolean),
        expectedBefore: Schema.optional(
          Schema.Union(
            Schema.Struct({ present: Schema.Literal(false) }),
            Schema.Struct({
              present: Schema.Literal(true),
              digest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
            }),
          ),
        ),
      }),
      Schema.Struct({
        kind: Schema.Literal("remove"),
        path: Schema.String,
        expectedBefore: Schema.optional(
          Schema.Union(
            Schema.Struct({ present: Schema.Literal(false) }),
            Schema.Struct({
              present: Schema.Literal(true),
              digest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u)),
            }),
          ),
        ),
      }),
    ),
  ),
});
export type TransactionRequest = typeof TransactionRequest.Type;
interface PlannedEntry {
  readonly entry: Entry;
  readonly beforeBytes: Uint8Array;
  readonly afterBytes: Uint8Array;
}

export const planTransaction = async (
  root: string,
  request: TransactionRequest,
  id: string,
): Promise<readonly PlannedEntry[]> => {
  const plans: PlannedEntry[] = [];
  const targets = new Set<string>();
  const artifacts = new Set<string>();
  for (const operation of request.operations) {
    const target = await targetPath(root, operation.path);
    const path = relative(root, target);
    if (targets.has(target)) throw transactionError("path", "prepare", operation.path);
    targets.add(target);
    const before = await snapshot(target);
    const expected = operation.expectedBefore;
    if (
      expected !== undefined &&
      (expected.present !== before.state.present ||
        (expected.present && (!before.state.present || expected.digest !== before.state.digest)))
    ) {
      throw transactionError("conflict", "prepare", operation.path);
    }
    const backup = `${path}.bak.${before.state.present ? before.state.digest : ""}`;
    let afterBytes: Uint8Array;
    let after: Entry["after"];
    switch (operation.kind) {
      case "write":
        afterBytes =
          typeof operation.content === "string"
            ? new TextEncoder().encode(operation.content)
            : new Uint8Array(operation.content);
        after = {
          present: true,
          digest: digestOf(afterBytes),
          mode: operation.secret || !before.state.present ? 0o600 : before.state.mode,
        };
        break;
      case "remove":
        afterBytes = new Uint8Array();
        after = { present: false };
        break;
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
    if (sameState(before.state, after)) continue;
    if (before.state.present) artifacts.add(resolve(root, backup));
    if (after.present) artifacts.add(`${target}.lando-stage.${id}`);
    plans.push({
      entry: { path, before: before.state.present ? { ...before.state, backup } : before.state, after },
      beforeBytes: before.bytes,
      afterBytes,
    });
  }
  const paths = [...targets, ...artifacts];
  if (
    paths.length !== new Set(paths).size ||
    paths.some((path) => paths.some((other) => other !== path && other.startsWith(`${path}${sep}`)))
  ) {
    throw transactionError("path", "prepare");
  }
  for (const artifact of artifacts) {
    await targetPath(root, relative(root, artifact));
    if (artifact.endsWith(`.lando-stage.${id}`) && (await statMaybe(artifact)) !== null) {
      throw transactionError("conflict", "prepare");
    }
  }
  return plans;
};
