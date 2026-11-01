import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { validateLandofileReplacement } from "../src/service.ts";
import * as TsLoader from "../src/ts-loader.ts";
import * as Validation from "../src/validation.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-replacement-operation-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const replace = (content: string) =>
  validateLandofileReplacement(
    { appRoot: root, targetFile: join(root, ".lando.yml"), content },
    {
      ports: makeTestLandofilePorts(root),
      stateStore: makeTestLandofileStateStore(),
      templates: { modules: [] },
    },
  );

test("does not acquire removed dependencies or parse old target bytes", async () => {
  await writeFile(join(root, ".lando.yml"), "name: old\nincludes: [missing.yml]\n");
  await Effect.runPromise(replace("name: repaired\n"));
  expect(await Bun.file(join(root, ".lando.yml")).text()).toBe("name: old\nincludes: [missing.yml]\n");
});

test("preserves noncandidate parse failures instead of relabeling the loader error", async () => {
  await writeFile(join(root, ".lando.yml"), "name: old\n");
  await writeFile(join(root, ".lando.local.yml"), ":\n  - invalid\n::::\n");
  const result = await Effect.runPromiseExit(replace("name: candidate\n"));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const error = Cause.findErrorOption(result.cause);
    expect(error._tag === "Some" ? error.value._tag : undefined).toBe("LandofileParseError");
  }
});

test("attributes candidate schema failures even when a local override masks the invalid value", async () => {
  await writeFile(join(root, ".lando.local.yml"), "name: local\nruntime: 4\n");
  const result = await Effect.runPromiseExit(replace("runtime: wrong\n"));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const error = Cause.findErrorOption(result.cause);
    expect(error._tag === "Some" ? error.value : undefined).toMatchObject({
      _tag: "LandofileWriteValidationError",
      issues: [
        expect.objectContaining({
          source: { file: join(root, ".lando.yml"), layer: "canonical", path: ["runtime"] },
        }),
      ],
    });
  }
});

test("evaluates untouched TypeScript once and performs one normal effective finalization", async () => {
  await writeFile(
    join(root, ".lando.base.ts"),
    'export default { name: "once", services: { web: { image: "node:22" } } };\n',
  );
  const evaluate = spyOn(TsLoader, "loadLandofileTs");
  const finalize = spyOn(Validation, "validateLandofile");
  try {
    await Effect.runPromise(replace("services:\n  web:\n    primary: true\n"));
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(await Bun.file(join(root, ".lando.yml")).exists()).toBe(false);
  } finally {
    evaluate.mockRestore();
    finalize.mockRestore();
  }
});

test("validates a new dist candidate below existing authored overrides without writing it", async () => {
  await writeFile(join(root, ".lando.yml"), "services:\n  web:\n    type: false\n");
  const result = await Effect.runPromiseExit(
    validateLandofileReplacement(
      {
        appRoot: root,
        targetFile: join(root, ".lando.dist.yml"),
        content: "name: global\nruntime: 4\nservices:\n  web:\n    type: compose\n    image: alpine:3.21\n",
      },
      {
        ports: makeTestLandofilePorts(root),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      },
    ),
  );
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) {
    const error = Cause.findErrorOption(result.cause);
    expect(error._tag === "Some" ? error.value._tag : undefined).toBe("LandofileWriteValidationError");
  }
  expect(await Bun.file(join(root, ".lando.dist.yml")).exists()).toBe(false);
});
