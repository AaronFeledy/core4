import { expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { Renderer } from "@lando/sdk/services";
import { Effect } from "effect";
import { spec } from "../src/command.ts";
import { renderInspection } from "../src/render.ts";
import { repository, validWorkflow } from "./fixtures.ts";

it("documents plugin flag values and descriptions through source CLI help", async () => {
  await using repo = await repository({});
  const env = {
    ...process.env,
    NO_COLOR: "1",
    LANDO_USER_CONF_ROOT: join(repo.root, "conf"),
    LANDO_USER_DATA_ROOT: join(repo.root, "data"),
    LANDO_USER_CACHE_ROOT: join(repo.root, "cache"),
    LANDO_SYSTEM_PLUGIN_ROOT: join(repo.root, "system"),
  };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "../../../core/bin/lando.ts"), ...args],
      {
        cwd: repo.root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  const link = await run(["meta:plugin:link", resolve(import.meta.dir, ".."), "--format=json"]);
  expect(link.exitCode, `${link.stdout}\n${link.stderr}`).toBe(0);
  const help = await run(["github-actions:list", "--help"]);
  expect(help.exitCode, help.stderr).toBe(0);
  expect(help.stdout).toContain("\n  lando github-actions:list\n");
  expect(help.stdout).toContain(
    "--root <value> Repository directory (defaults to invocation working directory).",
  );
  expect(help.stdout).toContain(
    "--workflow <value> Exact .github/workflows/<filename>.yml or .yaml path; no glob patterns.",
  );
  expect(help.stdout).toContain("--json [fields]");
  expect(help.stdout).not.toContain("\n  --json");
  expect(help.stdout).not.toContain("$ lando");
});

it("returns successful completion when inspection contains negative findings", async () => {
  await using repo = await repository({ "invalid.yml": "on: [" });
  const result = await Effect.runPromise(
    spec.run({ argv: [], parsedArgv: [], flags: { root: repo.root }, args: {} }),
  );
  expect(result.summary.failed).toBe(1);
  expect(spec.completion()).toEqual({ ok: true, exitCode: 0 });
});

it("captures the invocation cwd before deferred operation import and execution", async () => {
  const invocation = process.cwd();
  await using selected = await repository({ "ci.yml": validWorkflow });
  await using repo = await repository({});
  try {
    process.chdir(selected.root);
    const effect = spec.run({
      argv: [],
      parsedArgv: [],
      flags: { workflow: ".github/workflows/ci.yml" },
      args: {},
    });
    process.chdir(repo.root);
    const result = await Effect.runPromise(effect);
    expect(result.workflows[0]?.source.workflow).toBe(".github/workflows/ci.yml");
    expect(result.summary.inspected).toBe(1);
  } finally {
    process.chdir(invocation);
  }
});

it("renders complete source-located facts only through Renderer stdout", async () => {
  await using repo = await repository({ "ci.yml": validWorkflow });
  const input = { argv: [], parsedArgv: [], flags: { root: repo.root }, args: {} };
  const result = await Effect.runPromise(spec.run(input));
  let output = "";
  const renderer = Renderer.of({
    id: "test",
    capabilities: { color: false, interactive: false, animation: false, notifications: false },
    message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
    output: {
      stdout: (chunk) =>
        Effect.sync(() => {
          output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        }),
      stderr: () => Effect.void,
    },
  });
  await Effect.runPromise(
    spec
      .render({ input, result, stdout: "", stderr: "", exitCode: 0 })
      .pipe(Effect.provideService(Renderer, renderer)),
  );
  expect(output).toBe(`${renderInspection(result)}\n`);
  expect(output).toContain(".github/workflows/ci.yml");
  expect(output).toMatch(/4\s*\|\s*build/);
  expect(output).toContain("build");
  expect(output).not.toContain("PRIVATE_SCRIPT");
});

it("provides an actionable empty-state formatter without requiring runtime services", async () => {
  await using repo = await repository({});
  const result = await Effect.runPromise(
    spec.run({ argv: [], parsedArgv: [], flags: { root: repo.root }, args: {} }),
  );
  const output = renderInspection(result);
  expect(output).toContain("No workflow files found");
  expect(output).toContain("--root <directory>");
});
