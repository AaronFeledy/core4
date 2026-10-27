import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeManagedFileTransactions } from "@lando/managed-file/transaction";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { type RouterFixture, lastEnvelope, makeFixture, runSource } from "./subprocess-support.ts";

const preload = new URL("./fixtures/config-preview-acquisition.ts", import.meta.url).pathname;
const original = "name: preview\nincludes:\n  - source: github:acme/shared\n    path: fragment.yml\n";
const configureNotify = async (fixture: RouterFixture, commandId: string) => {
  const conf = fixture.env.LANDO_USER_CONF_ROOT;
  if (conf === undefined) throw new Error("Missing isolated config root");
  await mkdir(conf, { recursive: true });
  await writeFile(
    join(conf, "config.yml"),
    `notify:\n  commands:\n    - "${commandId}"\n    - "${commandId}:set"\n    - "${commandId}:unset"\n`,
  );
};
const snapshot = async (root: string) => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .sort((left, right) =>
        join(left.parentPath, left.name).localeCompare(join(right.parentPath, right.name)),
      )
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, (await readFile(path)).toString("base64")] as const;
      }),
  );
};

for (const global of [false, true]) {
  const command = global ? "global:config" : "app:config";
  const commandId = global ? "meta:global:config" : "app:config";
  for (const notify of [false, true]) {
    test.each(["set", "unset"] as const)(
      `${command} %s preview does not pin existing unpinned includes during bootstrap (notify=${notify})`,
      async (verb) => {
        // Given
        const fixture = await makeFixture("config-preview");
        try {
          if (notify) await configureNotify(fixture, commandId);
          const data = fixture.env.LANDO_USER_DATA_ROOT;
          if (data === undefined) throw new Error("Missing isolated data root");
          const target = global ? join(data, "global") : fixture.root;
          await mkdir(target, { recursive: true });
          await writeFile(join(fixture.root, ".lando.yml"), original);
          await writeFile(join(target, ".lando.yml"), original);
          const before = await snapshot(target);
          // When
          const result = await runSource(
            fixture,
            [
              command,
              verb,
              "services.web.primary",
              ...(verb === "set" ? ["false", "--type=boolean"] : []),
              "--dry-run",
              "--format=json",
            ],
            ["--preload", preload],
          );
          // Then
          expect(result.exitCode, result.stdout + result.stderr).toBe(0);
          expect(lastEnvelope(result.stdout)).toMatchObject({ ok: true, result: { dryRun: true } });
          expect(await snapshot(target)).toEqual(before);
          expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).exists()).toBe(false);
        } finally {
          await fixture.cleanup();
        }
      },
      30_000,
    );

    test(`${command} preview refuses a real prepared journal without recovery (notify=${notify})`, async () => {
      // Given
      const fixture = await makeFixture("config-pending");
      try {
        if (notify) await configureNotify(fixture, commandId);
        const data = fixture.env.LANDO_USER_DATA_ROOT;
        if (data === undefined) throw new Error("Missing isolated data root");
        const target = global ? join(data, "global") : fixture.root;
        await mkdir(target, { recursive: true });
        await writeFile(join(target, ".lando.yml"), "name: before\n");
        const privateFileAccess = await Effect.runPromise(
          PrivateFileAccessService.pipe(Effect.provide(PrivateFileAccessService.layer)),
        );
        const transactions = makeManagedFileTransactions({ journalRoot: () => data, privateFileAccess });
        await Effect.runPromise(
          Effect.scoped(
            transactions.prepare({
              appRoot: target,
              operations: [{ kind: "write", path: ".lando.yml", content: "name: recovered\n" }],
            }),
          ),
        );
        const before = await snapshot(target);
        const journals = await snapshot(join(data, "managed-files"));
        // When
        const result = await runSource({ ...fixture, root: target }, [
          ...(notify ? [`${commandId}:set`] : [command, "set"]),
          "name",
          "candidate",
          "--dry-run",
          "--format=json",
        ]);
        // Then
        expect(result.exitCode, result.stdout + result.stderr).toBe(1);
        expect(lastEnvelope(result.stdout)).toMatchObject({
          ok: false,
          error: { _tag: "ManagedFileTransactionError", phase: "inspect", reason: "pending-transaction" },
        });
        expect(await snapshot(target)).toEqual(before);
        expect(await snapshot(join(data, "managed-files"))).toEqual(journals);
        expect(await Effect.runPromise(transactions.pending(target))).toMatchObject({ state: "prepared" });
      } finally {
        await fixture.cleanup();
      }
    }, 30_000);
  }
}
