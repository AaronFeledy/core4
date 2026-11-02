import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { makeTestLandofilePorts } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-lint-readiness-"));
  await writeFile(join(root, ".lando.yml"), "name: inspect\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

for (const contextual of [false, true]) {
  test.each(["prepared", "committing", "blocked", "committed"] as const)(
    `inspects %s readiness without recovery (contextual=${contextual})`,
    async (state) => {
      // Given: the guard owns journal policy; lint must only request inspection.
      const inspected: string[] = [];
      const recovered: string[] = [];
      const failure = new ManagedFileTransactionError({
        reason: state === "blocked" ? "blocked" : "pending-transaction",
        phase: "inspect",
        path: root,
        cause: "invariant",
        remediation: "Recover the transaction with an ordinary load.",
      });
      const guard = ManagedFileTransactionGuard.of({
        assertReadable: (appRoot) =>
          Effect.suspend(() => {
            inspected.push(appRoot);
            return state === "committed" ? Effect.void : Effect.fail(failure);
          }),
        ensureConsistent: (appRoot) =>
          Effect.sync(() => {
            recovered.push(appRoot);
          }),
        pending: () => Effect.die("Journal policy belongs to the guard"),
      });

      // When
      const snapshot = await Effect.runPromise(
        lintLandofileSnapshot(
          { cwd: root },
          {
            templates: { modules: [] },
            ports: makeTestLandofilePorts(root),
            ...(contextual ? {} : { transactionGuard: guard }),
          },
        ).pipe(Effect.provideService(ManagedFileTransactionGuard, guard)),
      );

      // Then: pending/blocked errors remain lint load findings, not request failures.
      expect(inspected).toEqual([root]);
      expect(recovered).toEqual([]);
      expect(snapshot.result.valid).toBe(state === "committed");
      expect(snapshot.result.violations).toEqual(
        state === "committed"
          ? []
          : [
              expect.objectContaining({
                rule: "landofile.load",
                severity: "error",
                suggestion: failure.remediation,
              }),
            ],
      );
    },
  );
}
