import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EditorRunner, config } from "@lando/engine/operations/config";
import { GlobalConfigSources } from "@lando/engine/services/config";
import type { StateStore } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { appConfigEdit, appConfigSet, appConfigUnset } from "../../../src/cli/commands/app-config.ts";
import {
  globalConfigEdit,
  globalConfigSet,
  globalConfigUnset,
} from "../../../src/cli/commands/meta/global-config.ts";
import { testStateStoreLayer } from "../../_support/landofile-layer.ts";

interface Mutation {
  readonly subcommand: "set" | "unset" | "edit";
  readonly key?: string;
  readonly value?: string;
  readonly dryRun?: boolean;
  readonly editorRunner?: EditorRunner;
}
type MutationError = Effect.Error<
  ReturnType<
    | typeof config
    | typeof appConfigSet
    | typeof appConfigUnset
    | typeof appConfigEdit
    | typeof globalConfigSet
    | typeof globalConfigUnset
    | typeof globalConfigEdit
  >
>;
interface MutationObservation {
  readonly changed?: boolean;
}
interface MutationAdapter {
  readonly name: string;
  readonly filename: string;
  readonly prefix: string;
  readonly invoke: (
    root: string,
    options: Mutation,
  ) => Effect.Effect<MutationObservation, MutationError, StateStore>;
}
const adapters: readonly MutationAdapter[] = [
  {
    name: "installation",
    filename: "config.yml",
    prefix: "",
    invoke: (root: string, options: Mutation) =>
      config({ ...options, configPath: join(root, "config.yml") }).pipe(
        Effect.provideService(GlobalConfigSources, {
          env: {},
          sources: { user: true, env: false },
          rootOverrides: { userConfRoot: root },
        }),
      ),
  },
  {
    name: "app",
    filename: ".lando.yml",
    prefix: "name: app\nruntime: 4\n",
    invoke: (root: string, options: Mutation) => {
      switch (options.subcommand) {
        case "set":
          return appConfigSet({ ...options, cwd: root });
        case "unset":
          return appConfigUnset({ ...options, cwd: root });
        case "edit":
          return appConfigEdit({ ...options, cwd: root });
      }
    },
  },
  {
    name: "global",
    filename: ".lando.yml",
    prefix: "name: global\nruntime: 4\n",
    invoke: (root: string, options: Mutation) => {
      const path = join(root, ".lando.yml");
      switch (options.subcommand) {
        case "set":
          return globalConfigSet(options, path);
        case "unset":
          return globalConfigUnset(options, path);
        case "edit":
          return globalConfigEdit(options, path);
      }
    },
  },
];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const adapter of adapters) {
  test.each(["set-noop", "unset-noop", "edit-noop", "preview", "write", "invalid", "editor-failed"] as const)(
    `${adapter.name} mutation contract: %s`,
    async (scenario) => {
      // Given an actual authored file and its identity before mutation.
      const root = await mkdtemp(join(tmpdir(), "lando-document-contract-"));
      roots.push(root);
      const file = join(root, adapter.filename);
      const source = `${adapter.prefix}# preserve\nrouter:\n  httpPort: 8080\n`;
      await writeFile(file, source);
      const before = await stat(file);
      const edited = `${adapter.prefix}# exact editor bytes\nrouter:\n  httpPort: 8081 # chosen\n\n`;
      const options = (): Mutation => {
        switch (scenario) {
          case "set-noop":
            return { subcommand: "set", key: "router.httpPort", value: "8080" };
          case "unset-noop":
            return { subcommand: "unset", key: "router.httpsPort" };
          case "edit-noop":
            return { subcommand: "edit", editorRunner: async () => ({ kind: "edited", content: source }) };
          case "preview":
            return {
              subcommand: "edit",
              dryRun: true,
              editorRunner: async () => ({ kind: "edited", content: edited }),
            };
          case "write":
            return { subcommand: "edit", editorRunner: async () => ({ kind: "edited", content: edited }) };
          case "invalid":
            return { subcommand: "set", key: "router.httpPort", value: "invalid" };
          case "editor-failed":
            return {
              subcommand: "edit",
              editorRunner: async () => ({ kind: "failed", reason: "exit 7", exitCode: 7 }),
            };
        }
      };
      // When the real command adapter executes against that file.
      const result = await Effect.runPromise(
        adapter.invoke(root, options()).pipe(Effect.result, Effect.provide(testStateStoreLayer)),
      );
      // Then no-op/preview/failure paths preserve file identity; writes preserve exact editor text.
      if (scenario === "invalid" || scenario === "editor-failed") {
        expect(Result.isFailure(result)).toBe(true);
      } else {
        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result))
          expect(result.success.changed).toBe(scenario === "preview" || scenario === "write");
      }
      expect(await Bun.file(file).text()).toBe(scenario === "write" ? edited : source);
      if (scenario !== "write") {
        const after = await stat(file);
        expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      }
    },
  );
}
