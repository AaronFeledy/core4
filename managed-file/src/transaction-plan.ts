import { relative, resolve, sep } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { Schema } from "effect";
import { planCreateDestination } from "./transaction-create-path.ts";
import { transactionError } from "./transaction-error.ts";
import { sameState, snapshot, statMaybe, targetPath } from "./transaction-fs.ts";
import type { DirectoryPolicy, Entry } from "./transaction-journal.ts";

const SafeMode = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 0o777 })),
);
const ExpectedBefore = Schema.Union([
  Schema.Struct({ present: Schema.Literal(false) }),
  Schema.Struct({
    present: Schema.Literal(true),
    digest: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  }),
]);

export const TransactionRequest = Schema.Struct({
  appRoot: Schema.String,
  readConditions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        expectedBefore: ExpectedBefore,
      }),
    ),
  ),
  operations: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("write"),
        path: Schema.String,
        content: Schema.Union([Schema.String, Schema.Uint8Array]),
        secret: Schema.optionalKey(Schema.Boolean),
        expectedBefore: Schema.optionalKey(
          Schema.Union([
            Schema.Struct({ present: Schema.Literal(false) }),
            Schema.Struct({
              present: Schema.Literal(true),
              digest: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
            }),
          ]),
        ),
      }),
      Schema.Struct({
        kind: Schema.Literal("create"),
        path: Schema.String,
        content: Schema.Union([Schema.String, Schema.Uint8Array]),
        mode: Schema.optionalKey(SafeMode),
      }),
      Schema.Struct({
        kind: Schema.Literal("remove"),
        path: Schema.String,
        expectedBefore: Schema.optionalKey(
          Schema.Union([
            Schema.Struct({ present: Schema.Literal(false) }),
            Schema.Struct({
              present: Schema.Literal(true),
              digest: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
            }),
          ]),
        ),
      }),
    ]),
  ),
});
export type TransactionRequest = typeof TransactionRequest.Type;

/** Advisory-lock preconditions, not filesystem CAS against non-cooperating writers. */
export const verifyTransactionConditions = async (
  root: string,
  conditions: TransactionRequest["readConditions"],
  phase: "prepare" | "commit",
): Promise<void> => {
  for (const condition of conditions ?? []) {
    const path = await targetPath(root, condition.path);
    const before = await snapshot(path);
    const expected = condition.expectedBefore;
    if (
      expected.present !== before.state.present ||
      (expected.present && (!before.state.present || expected.digest !== before.state.digest))
    ) {
      throw transactionError("conflict", phase, condition.path);
    }
  }
};
interface PlannedEntry {
  readonly entry: Entry;
  readonly beforeBytes: Uint8Array;
  readonly afterBytes: Uint8Array;
  readonly stagePath?: string;
}
export interface TransactionPlan {
  readonly entries: readonly PlannedEntry[];
  readonly directoryPolicy: readonly DirectoryPolicy[];
}

export const planTransaction = async (
  root: string,
  request: TransactionRequest,
  id: string,
): Promise<TransactionPlan> => {
  await verifyTransactionConditions(root, request.readConditions, "prepare");
  const plans: PlannedEntry[] = [];
  const directoryPolicy: DirectoryPolicy[] = [];
  const directories = new Set<string>();
  const targets = new Set<string>();
  const artifacts = new Set<string>();
  for (const operation of request.operations) {
    if (operation.kind === "create") {
      const destination = await planCreateDestination(root, operation.path, { id, index: plans.length });
      if (targets.has(destination.target)) throw transactionError("path", "prepare", operation.path);
      targets.add(destination.target);
      const afterBytes =
        typeof operation.content === "string"
          ? new TextEncoder().encode(operation.content)
          : new Uint8Array(operation.content);
      for (const parent of destination.missingParents) {
        if (directories.has(parent)) continue;
        directories.add(parent);
        directoryPolicy.push({ path: parent, action: "create-if-absent" });
      }
      artifacts.add(destination.stagePath);
      plans.push({
        entry: {
          path: destination.relativePath,
          before: { present: false },
          after: { present: true, digest: sha256Hex(afterBytes), mode: operation.mode ?? 0o644 },
          publication: "create",
        },
        beforeBytes: new Uint8Array(),
        afterBytes,
        stagePath: destination.stagePath,
      });
      continue;
    }
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
          digest: sha256Hex(afterBytes),
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
  const sources = await Promise.all(
    (request.readConditions ?? []).map((condition) => targetPath(root, condition.path)),
  );
  const paths = [...new Set([...targets, ...sources]), ...artifacts];
  if (
    paths.length !== new Set(paths).size ||
    paths.some((path) => paths.some((other) => other !== path && other.startsWith(`${path}${sep}`)))
  ) {
    throw transactionError("path", "prepare");
  }
  for (const artifact of artifacts) {
    await targetPath(root, relative(root, artifact));
    if (artifact.includes(`.lando-stage.${id}`) && (await statMaybe(artifact)) !== null) {
      throw transactionError("conflict", "prepare");
    }
  }
  return { entries: plans, directoryPolicy };
};
