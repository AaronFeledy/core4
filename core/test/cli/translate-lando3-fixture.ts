import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigTranslators } from "@lando/lando3";
import { configTranslators } from "@lando/lando4";
import { createRedactor } from "@lando/sdk/secrets";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  type AppConfigTranslateOptions,
  appConfigTranslate,
} from "../../src/cli/commands/app-config-translate.ts";
import { lampDecomposer } from "../../src/recipes/builtin/lamp/decomposer.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

export const originals = {
  ".lando.yml": "name: commit-test\nrecipe: lamp\nconfig: {php: '8.3'}\n",
  ".lando.recipe.yml": "services:\n  cache:\n    type: redis:7\n",
  ".lando.local.yml": "services:\n  cache:\n    overrides:\n      environment: {LOCAL: yes}\n",
};
export const snapshot = async (root: string) =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(root))
        .filter((name) => name.endsWith(".yml"))
        .sort()
        .map(async (name) => [name, await Bun.file(join(root, name)).text()] as const),
    ),
  );
export const withFixture = async (
  body: (fixture: {
    readonly root: string;
    readonly journalRoot: () => string;
    readonly translators: readonly ConfigTranslatorShape[];
    readonly run: (options?: AppConfigTranslateOptions) => ReturnType<typeof appConfigTranslate>;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando3-commit-"));
  const loader = configTranslators.get("lando4");
  if (loader === undefined) throw new Error("missing lando4 encoder");
  const legacyLoader = makeConfigTranslators({
    decomposers: new Map([["lamp", lampDecomposer]]),
    redactor: createRedactor("secrets"),
  }).get("lando3");
  if (legacyLoader === undefined) throw new Error("missing lando3 translator");
  const translators = [await legacyLoader(), await loader()];
  try {
    for (const [name, bytes] of Object.entries(originals)) await Bun.write(join(root, name), bytes);
    await withEnvVar("LANDO_USER_DATA_ROOT", join(root, "journal"), () =>
      body({
        root,
        journalRoot: () => join(root, "journal"),
        translators,
        run: (options = {}) =>
          appConfigTranslate({
            cwd: root,
            from: "lando3",
            translators,
            privateFileAccess: ownerOnlyFileAccess,
            ...options,
          }),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
export const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect));
