import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorRunner } from "@lando/engine/config-write/editor";
import { ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { appConfigEdit } from "../../../src/cli/commands/app-config.ts";
import { globalConfigEdit } from "../../../src/cli/commands/meta/global-config.ts";
import { type GlobalConfigTestServices, globalConfigLayer } from "../../_support/global-config-layer.ts";

const roots: string[] = [];
const root = async () => {
  const path = await mkdtemp(join(tmpdir(), "lando-config-readiness-"));
  roots.push(path);
  return path;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
interface EditObservation {
  readonly changed?: boolean;
}
interface EditAdapter {
  readonly name: string;
  readonly edit: (
    cwd: string,
    editorRunner: EditorRunner,
    dryRun: boolean,
  ) => Effect.Effect<
    EditObservation,
    Effect.Error<ReturnType<typeof appConfigEdit | typeof globalConfigEdit>>,
    GlobalConfigTestServices
  >;
}
const adapters: readonly EditAdapter[] = [
  {
    name: "app",
    edit: (cwd: string, editorRunner: EditorRunner, dryRun: boolean) =>
      appConfigEdit({ cwd, editorRunner, dryRun }),
  },
  {
    name: "global",
    edit: (cwd: string, editorRunner: EditorRunner, dryRun: boolean) =>
      globalConfigEdit({ editorRunner, dryRun }, join(cwd, ".lando.yml")),
  },
];
for (const adapter of adapters) {
  for (const dryRun of [false, true]) {
    test.each([1, 2])(
      `${adapter.name} checks readiness before read/editor and candidate (dryRun=${dryRun}, block=%s)`,
      async (blockAt) => {
        // Given a guard that blocks either acquisition or candidate validation.
        const cwd = await root();
        const file = join(cwd, ".lando.yml");
        const original = "name: [malformed\n";
        await writeFile(file, original);
        const error = new ManagedFileTransactionError({
          reason: "pending-transaction",
          phase: "inspect",
          path: cwd,
          cause: "invariant",
          remediation: "Recover the pending transaction.",
        });
        let checks = 0;
        let opened = 0;
        const guard = ManagedFileTransactionGuard.of({
          assertReadable: () =>
            Effect.suspend(() => (++checks === blockAt ? Effect.fail(error) : Effect.void)),
          ensureConsistent: () => Effect.die("Candidate must not recover"),
          pending: () => Effect.die("Adapter must not interpret transaction states"),
        });
        // When an editor repairs the malformed source, if readiness permits it to open.
        const result = await Effect.runPromise(
          Effect.result(
            adapter.edit(
              cwd,
              async ({ content }) => {
                expect(content).toBe(original);
                opened++;
                return { kind: "edited", content: "name: repaired\nruntime: 4\n" };
              },
              dryRun,
            ),
          ).pipe(
            Effect.provideService(ManagedFileTransactionGuard, guard),
            Effect.provide(globalConfigLayer(cwd)),
          ),
        );
        // Then the guard's typed failure prevents persistence at either boundary.
        expect(result).toEqual(Result.fail(error));
        expect(opened).toBe(blockAt - 1);
        expect(checks).toBe(blockAt);
        expect(await Bun.file(file).text()).toBe(original);
      },
    );
  }
  test(`${adapter.name} editor repairs malformed original bytes`, async () => {
    // Given malformed original YAML.
    const cwd = await root();
    const file = join(cwd, ".lando.yml");
    await writeFile(file, "name: [malformed\n");
    const edited = "# repaired\nname: repaired\nruntime: 4\n\n";
    // When the editor returns a valid exact buffer.
    const result = await Effect.runPromise(
      adapter
        .edit(cwd, async () => ({ kind: "edited", content: edited }), false)
        .pipe(Effect.provide(globalConfigLayer(cwd))),
    );
    // Then the malformed original never blocks the repair.
    expect(result.changed).toBe(true);
    expect(await Bun.file(file).text()).toBe(edited);
  });
}

test("saving the unchanged global seed creates an absent document", async () => {
  // Given a root without a persisted global Landofile.
  const cwd = await root();
  const file = join(cwd, ".lando.yml");
  // When the editor accepts its seed unchanged.
  const result = await Effect.runPromise(
    globalConfigEdit({ editorRunner: async ({ content }) => ({ kind: "edited", content }) }, file).pipe(
      Effect.provide(globalConfigLayer(cwd)),
    ),
  );
  // Then seed equality does not hide a real creation.
  expect(result.changed).toBe(true);
  expect(await Bun.file(file).text()).toBe("name: global\nruntime: 4\n");
});
