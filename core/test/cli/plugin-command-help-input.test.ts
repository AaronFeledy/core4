import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");

test("plugin machine help carries choices, required inputs and stdio arguments (#2053)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-help-input-"));
  try {
    const plugins = join(root, ".lando/plugins");
    const path = join(plugins, "fixture");
    await mkdir(path, { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: help-input\n");
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({
        landoPlugin: {
          name: "@example/help-input",
          version: "1.0.0",
          api: 4,
          entry: "index.ts",
          contributes: { commands: [{ id: "fixture:dump", summary: "Dump a fixture." }] },
        },
      }),
    );
    await writeFile(
      join(plugins, "registry.json"),
      JSON.stringify({
        "@example/help-input": { name: "@example/help-input", version: "1.0.0", path },
      }),
    );
    await writeFile(
      join(path, "index.ts"),
      `import { Effect, Schema } from "effect";
export const commands = new Map([["fixture:dump", async () => ({
  id: "fixture:dump", namespace: "fixture", summary: "Dump a fixture.", bootstrap: "plugins",
  flags: {
    mode: { type: "string", description: "Dump mode.", options: ["plain", "archive"], required: true, default: "plain" },
    table: { type: "option", description: "Tables to dump.", multiple: true },
    count: { type: "number", valueType: "integer", description: "Row limit.", default: 0 },
    yes: { type: "boolean", description: "Confirm dump.", default: false },
  },
  args: {
    service: { type: "string", description: "Source service.", required: true, options: ["database", "replica"] },
    file: { type: "string", description: "Output file.", default: "dump.out", stdio: "stdout" },
    source: { type: "string", description: "Input file.", stdio: "stdin" },
    extra: { type: "string", description: "Additional inputs.", multiple: true },
  },
  resultSchema: Schema.String, run: () => Effect.succeed("unused"),
})]]);`,
    );

    const child = Bun.spawn([process.execPath, cli, "help", "fixture:dump", "--format=json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
      },
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exit, `${stderr}\n${stdout}`).toBe(0);
    expect(JSON.parse(stdout).result.target.input).toEqual({
      flags: [
        {
          name: "mode",
          type: "string",
          description: "Dump mode.",
          options: ["plain", "archive"],
          required: true,
          multiple: false,
          default: "plain",
        },
        { name: "table", type: "string", description: "Tables to dump.", required: false, multiple: true },
        {
          name: "count",
          type: "integer",
          description: "Row limit.",
          required: false,
          multiple: false,
          default: 0,
        },
        {
          name: "yes",
          type: "boolean",
          description: "Confirm dump.",
          required: false,
          multiple: false,
          default: false,
          char: "y",
        },
      ],
      args: [
        {
          name: "service",
          description: "Source service.",
          options: ["database", "replica"],
          required: true,
          multiple: false,
        },
        {
          name: "file",
          description: "Output file. Use - to write to stdout.",
          required: false,
          multiple: false,
          default: "dump.out",
          stdio: "stdout",
        },
        {
          name: "source",
          description: "Input file. Use - to read from stdin.",
          required: false,
          multiple: false,
          stdio: "stdin",
        },
        { name: "extra", description: "Additional inputs.", required: false, multiple: true },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
