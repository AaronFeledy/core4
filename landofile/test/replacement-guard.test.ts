import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { validateLandofileReplacement } from "../src/service.ts";
import { makeTestLandofilePorts } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-candidate-guard-"));
  await writeFile(join(root, ".lando.yml"), "name: original\n");
  await writeFile(join(root, ".lando.local.yml"), "services: {}\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

for (const contextual of [false, true]) {
  test.each([false, true])(
    `requests readiness once without recovery (contextual=${contextual}, ready=%s)`,
    async (ready) => {
      // Given
      const roots: string[] = [];
      const failure = new ManagedFileTransactionError({
        reason: "pending-transaction",
        phase: "inspect",
        path: root,
        cause: "invariant",
        remediation: "Recover the transaction with an ordinary load.",
      });
      const guard = ManagedFileTransactionGuard.of({
        ensureConsistent: () => Effect.die("Candidate reads must not recover or clean up"),
        pending: () => Effect.die("Journal policy belongs to the guard"),
        assertReadable: (appRoot) =>
          Effect.suspend(() => {
            roots.push(appRoot);
            return ready ? Effect.void : Effect.fail(failure);
          }),
      });
      // When
      const result = await Effect.runPromise(
        validateLandofileReplacement(
          { appRoot: root, targetFile: join(root, ".lando.yml"), content: "name: candidate\n" },
          {
            ports: makeTestLandofilePorts(root),
            templates: { modules: [] },
            ...(contextual ? {} : { transactionGuard: guard }),
          },
        ).pipe(Effect.provideService(ManagedFileTransactionGuard, guard), Effect.result),
      );
      // Then
      expect(roots).toEqual([root]);
      if (ready) expect(Result.isSuccess(result)).toBe(true);
      else expect(Result.isFailure(result) && result.failure).toBe(failure);
    },
  );
}
