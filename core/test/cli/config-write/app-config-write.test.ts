import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  appConfigEdit,
  appConfigSet,
  appConfigUnset,
  appConfigValidate,
} from "../../../src/cli/commands/app-config.ts";
import type { EditorRunner } from "../../../src/recipes/prompts/editor-command.ts";

let dir = "";
const landofilePath = (): string => join(dir, ".lando.yml");

const seed = (content: string): Promise<void> => writeFile(landofilePath(), content, "utf8");
const readLandofile = (): Promise<string> => readFile(landofilePath(), "utf8");
const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-appcfg-"));
  await seed("name: myapp\nruntime: 4\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("app config set", () => {
  test("writes a scalar and reports changed (S1 happy path)", async () => {
    const result = await run(
      appConfigSet({ subcommand: "set", key: "services.web.type", value: "php:8.3", cwd: dir }),
    );
    expect(result.subcommand).toBe("set");
    expect(result.changed).toBe(true);
    const onDisk = await readLandofile();
    expect(onDisk).toContain("php:8.3");
    expect(onDisk).toContain("web");
  });

  test("--dry-run leaves the file untouched (S1 dry-run)", async () => {
    const before = await readLandofile();
    const result = await run(
      appConfigSet({ subcommand: "set", key: "services.web.type", value: "php", cwd: dir, dryRun: true }),
    );
    expect(result.dryRun).toBe(true);
    expect(await readLandofile()).toBe(before);
  });

  test("--path is honored when no positional key is given", async () => {
    const result = await run(
      appConfigSet({ subcommand: "set", path: "services.web.type", value: "php:8.3", cwd: dir }),
    );
    expect(result.key).toBe("services.web.type");
    expect(await readLandofile()).toContain("php:8.3");
  });

  test("--type json parses structured values", async () => {
    await run(
      appConfigSet({
        subcommand: "set",
        key: "services.web.environment",
        value: '{"APP_ENV":"prod"}',
        type: "json",
        cwd: dir,
      }),
    );
    expect(await readLandofile()).toContain("APP_ENV");
  });
});

describe("app config unset", () => {
  test("removes a key (S2)", async () => {
    await run(appConfigSet({ subcommand: "set", key: "services.web.type", value: "phpvalue", cwd: dir }));
    const result = await run(appConfigUnset({ subcommand: "unset", key: "services.web.type", cwd: dir }));
    expect(result.changed).toBe(true);
    expect(await readLandofile()).not.toContain("phpvalue");
  });

  test("missing key is a no-op change:false", async () => {
    const result = await run(appConfigUnset({ subcommand: "unset", key: "recipe", cwd: dir }));
    expect(result.changed).toBe(false);
  });

  test("--path is honored when no positional key is given", async () => {
    await run(appConfigSet({ subcommand: "set", key: "services.web.type", value: "phpvalue", cwd: dir }));
    const result = await run(appConfigUnset({ subcommand: "unset", path: "services.web.type", cwd: dir }));
    expect(result.changed).toBe(true);
    expect(await readLandofile()).not.toContain("phpvalue");
  });
});

describe("app config reject (S3) leaves file untouched", () => {
  test("malformed path fails with LandofileWriteValidationError", async () => {
    const before = await readLandofile();
    const exit = await runExit(appConfigSet({ subcommand: "set", key: "", value: "x", cwd: dir }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause.toString();
      expect(err).toContain("LandofileWriteValidationError");
    }
    expect(await readLandofile()).toBe(before);
  });

  test("schema-violating value aborts the write, file unchanged", async () => {
    await seed("name: myapp\nruntime: 4\n");
    const before = await readLandofile();
    const exit = await runExit(
      appConfigSet({ subcommand: "set", key: "runtime", value: "not-a-number", type: "string", cwd: dir }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readLandofile()).toBe(before);
  });

  test("serializer rejections fail with LandofileWriteValidationError, file unchanged", async () => {
    const before = await readLandofile();
    const exit = await runExit(
      appConfigSet({
        subcommand: "set",
        key: "services.web.environment",
        value: '{"bad key":"x"}',
        type: "json",
        cwd: dir,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("LandofileWriteValidationError");
    expect(await readLandofile()).toBe(before);
  });

  test("no Landofile in scope fails with remediation", async () => {
    await rm(landofilePath(), { force: true });
    const exit = await runExit(appConfigSet({ subcommand: "set", key: "a", value: "b", cwd: dir }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("LandofileNotFoundError");
  });
});

describe("app config validate (S5)", () => {
  test("valid file returns valid:true", async () => {
    const result = await run(appConfigValidate({ subcommand: "validate", cwd: dir }));
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("invalid file fails with issues + remediation", async () => {
    await seed("name: myapp\nruntime: 4\nbogusTopLevel: nope\n");
    const exit = await runExit(appConfigValidate({ subcommand: "validate", cwd: dir }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("LandofileWriteValidationError");
  });
});

describe("app config edit (S7) via injected editor seam", () => {
  const editorRunner =
    (transform: (content: string) => string): EditorRunner =>
    async ({ content }) => ({ kind: "edited", content: transform(content) });

  test("saves the edited buffer when valid", async () => {
    const result = await run(
      appConfigEdit({
        subcommand: "edit",
        cwd: dir,
        editorRunner: editorRunner((c) => `${c}services:\n  web:\n    type: php\n`),
      }),
    );
    expect(result.changed).toBe(true);
    expect(await readLandofile()).toContain("php");
  });

  test("rejects an edit that fails validation, file untouched", async () => {
    const before = await readLandofile();
    const exit = await runExit(
      appConfigEdit({
        subcommand: "edit",
        cwd: dir,
        editorRunner: editorRunner(() => "name: myapp\nruntime: 4\nbogusTopLevel: nope\n"),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readLandofile()).toBe(before);
  });

  test("no-editor fails with remediation", async () => {
    const exit = await runExit(
      appConfigEdit({ subcommand: "edit", cwd: dir, editorRunner: async () => ({ kind: "no-editor" }) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("editor");
  });
});
