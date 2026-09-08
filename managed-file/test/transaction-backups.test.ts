import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { fixture, scoped } from "./transaction-fixture.ts";

for (const checkpoint of ["prepared", "after-mutation"] as const) {
  for (const kind of ["write", "remove"] as const) {
    test(`rejects ${kind} when the later backup is corrupted at ${checkpoint}`, async () => {
      // Given two backed-up targets and corruption at a deterministic boundary
      const corrupt = "SECRET-CORRUPTED-BACKUP";
      const digest = createHash("sha256").update("old-b").digest("hex");
      const { appRoot, transactions } = await fixture((point, index) =>
        point === checkpoint && (checkpoint === "prepared" || index === 0)
          ? Effect.promise(() => writeFile(join(appRoot, `b.bak.${digest}`), corrupt))
          : Effect.void,
      );
      await writeFile(join(appRoot, "a"), "old-a");
      await writeFile(join(appRoot, "b"), "old-b");
      // When commit validates the backups globally and immediately before mutation
      const result = await scoped(
        Effect.either(
          transactions.run({
            appRoot,
            operations: [
              { kind: "write", path: "a", content: "new-a" },
              kind === "write" ? { kind, path: "b", content: "new-b" } : { kind, path: "b" },
            ],
          }),
        ),
      );
      // Then the failing entry is untouched and recovery metadata remains private
      expect(result._tag).toBe("Left");
      expect(await readFile(join(appRoot, "a"), "utf8")).toBe(checkpoint === "prepared" ? "old-a" : "new-a");
      expect(await readFile(join(appRoot, "b"), "utf8")).toBe("old-b");
      const journal = await scoped(transactions.readJournal(appRoot));
      expect(journal?.state).toBe(checkpoint === "prepared" ? "prepared" : "committing");
      expect(JSON.stringify(result)).not.toContain(corrupt);
      expect(JSON.stringify(journal)).not.toContain(corrupt);
    });
  }
}
