import { expect, it } from "bun:test";
import { Renderer } from "@lando/sdk/services";
import { Effect } from "effect";
import { spec } from "../src/command.ts";
import { renderInspection } from "../src/render.ts";
import { repository, validWorkflow } from "./fixtures.ts";

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
