import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStandaloneRedactor } from "@lando/redaction/service";
import {
  computeRecipeContentDigest,
  fullRecipeMigratability,
  recipeContentDigestProjection,
  renderRecipeSnapshot,
} from "@lando/sdk/recipes";
import { type RecipeDecomposeInput, RecipeManifest, type RecipeOptionValue } from "@lando/sdk/schema";
import { runRecipeDecomposerContractSuite } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { fastapiDecomposer } from "../../src/recipes/builtin/fastapi/decomposer.ts";
import { fastapiRecipeSource, fastapiRecipeYaml } from "../../src/recipes/builtin/fastapi/manifest.ts";
import {
  FASTAPI_CONTENT_DIGEST,
  fastapiDefaults,
  fastapiProducer,
  fastapiSnapshot,
} from "../../src/recipes/builtin/fastapi/snapshot.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";

const defaults = { ...fastapiDefaults };
const validInput: RecipeDecomposeInput = { producer: fastapiProducer, options: defaults, secrets: {} };
const decomposer = fastapiDecomposer({ redactor: createStandaloneRedactor("secrets") });

const decompose = (options: Readonly<Record<string, RecipeOptionValue>>) =>
  Effect.runSync(decomposer.decompose({ producer: fastapiProducer, options, secrets: {} }));

const authoringOf = (options: Readonly<Record<string, RecipeOptionValue>>) => {
  const { recipe: _recipe, ...authoring } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(decompose(options).fragment);
  return authoring;
};

const manifest = Schema.decodeUnknownSync(RecipeManifest)(
  Effect.runSync(parseRecipeYaml({ source: fastapiRecipeSource, content: fastapiRecipeYaml })),
);

const startupOf = () =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      services: Schema.Struct({
        web: Schema.Struct({
          entrypoint: Schema.Array(Schema.String),
        }),
      }),
    }),
  )(decompose(defaults).fragment).services.web;

test.skipIf(process.platform === "win32")(
  "initializes an empty venv directory and preserves argv and installed files on repeat startup",
  async () => {
    // Given: relocate only the container paths; use the real shell with a stock-interpreter stand-in.
    const root = await mkdtemp(join(tmpdir(), "lando-fastapi-startup-"));
    try {
      const python = join(root, "python");
      const venv = join(root, ".venv");
      await mkdir(venv);
      await Bun.write(
        python,
        '#!/bin/sh\n[ "$1" = -m ] && [ "$2" = venv ] || exit 91\nmkdir -p "$3/bin"\nprintf created >> "$3/creations"\ntouch "$3/bin/pip"\nchmod +x "$3/bin/pip"\n',
      );
      await chmod(python, 0o755);
      const startup = startupOf().entrypoint.map((arg) =>
        arg.replaceAll("/usr/local/bin/python", python).replaceAll("/app/.venv", venv),
      );
      const args = ["a b", "", "$(exit 99)", "quote'\"", "--reload"];
      const command = ["sh", "-c", 'printf "%s\\n" "$@"', "--", ...args];
      // When
      const first = Bun.spawnSync([...startup, ...command]);
      await Bun.write(join(venv, "installed-package"), "keep me");
      const second = Bun.spawnSync([...startup, ...command]);
      // Then
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.stdout.toString()).toBe(`${args.join("\n")}\n`);
      expect(second.stdout.toString()).toBe(`${args.join("\n")}\n`);
      expect(await Bun.file(join(venv, "installed-package")).text()).toBe("keep me");
      expect(await Bun.file(join(venv, "creations")).text()).toBe("created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "propagates bootstrap failure without executing the original command",
  async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-fastapi-failure-"));
    try {
      const python = join(root, "python");
      await Bun.write(python, "#!/bin/sh\nexit 37\n");
      await chmod(python, 0o755);
      const startup = startupOf().entrypoint.map((arg) =>
        arg.replaceAll("/usr/local/bin/python", python).replaceAll("/app/.venv", join(root, ".venv")),
      );
      // When
      const result = Bun.spawnSync([...startup, "sh", "-c", "printf should-not-run"]);
      // Then
      expect(result.exitCode).toBe(37);
      expect(result.stdout.toString()).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "propagates the original command failure when the venv exists",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-fastapi-command-"));
    try {
      await mkdir(join(root, ".venv", "bin"), { recursive: true });
      await Bun.write(join(root, ".venv", "bin", "pip"), "#!/bin/sh\nexit 0\n");
      await chmod(join(root, ".venv", "bin", "pip"), 0o755);
      const startup = startupOf().entrypoint.map((arg) =>
        arg
          .replaceAll("/usr/local/bin/python", join(root, "missing-python"))
          .replaceAll("/app/.venv", join(root, ".venv")),
      );
      const result = Bun.spawnSync([...startup, "sh", "-c", "exit 42"]);
      expect(result.exitCode).toBe(42);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

describe("fastapi decomposition", () => {
  test("satisfies the provider-free decomposer contract for valid and invalid inputs", async () => {
    await Effect.runPromise(
      runRecipeDecomposerContractSuite({
        name: "fastapi",
        factory: fastapiDecomposer,
        producer: fastapiProducer,
        validInput,
        typedOptionFailureInput: { ...validInput, options: { database: "postgres" } },
        missingRecipeInput: { ...validInput, producer: { ...fastapiProducer, recipeId: "missing" } },
      }),
    );
  });

  test("returns the exact authoring fragment for the recipe's only option set", () => {
    const result = decompose(defaults);
    expect(result.provenance).toEqual({
      id: "fastapi",
      version: "0.1.0",
      producer: fastapiProducer,
      options: {},
    });
    expect(authoringOf(defaults)).toEqual({
      runtime: 4,
      services: {
        web: {
          type: "python:3.12",
          framework: "fastapi",
          port: 8000,
          entrypoint: [
            "sh",
            "-c",
            '([ -x /app/.venv/bin/pip ] || /usr/local/bin/python -m venv /app/.venv) && exec "$@"',
            "--",
          ],
          environment: {
            VIRTUAL_ENV: "/app/.venv",
            PATH: "/app/.venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
          },
          dependsOn: ["database", "cache"],
          routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
        },
        database: { type: "postgres" },
        cache: { type: "redis" },
      },
      tooling: {
        uvicorn: { service: "web", description: "Run uvicorn inside the web service.", cmds: ["uvicorn"] },
        pip: { service: "web", description: "Run pip inside the web service.", cmds: ["pip"] },
      },
    });
    expect<unknown>(result.fragment).toEqual({
      runtime: 4,
      recipe: result.provenance,
      ...authoringOf(defaults),
    });
  });

  test("accepts the app-name answer the translator forwards and omits it from provenance", () => {
    const result = decompose({ name: "probe" });
    expect(result.provenance.options).toEqual({});
    expect(authoringOf({ name: "probe" })).toEqual(authoringOf(defaults));
  });

  test.each([{ celery: true }, { database: "mysql" }, { php: "8.3" }])(
    "rejects an undeclared option key when input is %j",
    (options) => {
      const failure = Effect.runSync(
        Effect.result(decomposer.decompose({ producer: fastapiProducer, options, secrets: {} })),
      );
      expect(Result.isFailure(failure)).toBe(true);
      if (Result.isFailure(failure)) {
        expect(failure.failure.reason).toBe("option-type");
        expect(failure.failure.path).toBe(`options.${Object.keys(options)[0] ?? ""}`);
        expect(failure.failure.remediation).toContain("declares no options");
      }
    },
  );

  test("publishes an explicit empty auxiliary inventory with declared files and postInit", () => {
    expect(manifest.files).toEqual([
      { src: "templates/.lando.yml.tmpl", dest: ".lando.yml", template: true },
    ]);
    expect(manifest.postInit).toHaveLength(1);
    expect(manifest.snapshot?.assets).toEqual([]);
  });

  test("publishes a self-consistent migratable snapshot with a matching content identity", () => {
    expect(computeRecipeContentDigest(recipeContentDigestProjection(manifest))).toBe(FASTAPI_CONTENT_DIGEST);
    expect(manifest.snapshot).toEqual(fastapiSnapshot);
    expect(fullRecipeMigratability(manifest, "bundled").status).toBe("migratable");
  });

  test("renders the same authoring data from the snapshot", () => {
    expect(Result.getOrThrow(renderRecipeSnapshot(fastapiSnapshot, defaults))).toEqual(authoringOf(defaults));
  });
});
