import { expect, it } from "bun:test";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { limits } from "../src/diagnostics.ts";
import { listWorkflows } from "../src/operations.ts";
import { repository, validWorkflow } from "./fixtures.ts";

it("discovers only direct workflow suffixes in deterministic order and preserves malformed rows", async () => {
  await using repo = await repository({
    "z.yaml": validWorkflow,
    "a.yml": "on: [",
    "notes.txt": "ignore",
    "-構築 checks.yml": validWorkflow,
  });
  await mkdir(join(repo.root, ".github/workflows/nested"));
  await writeFile(join(repo.root, ".github/workflows/nested/hidden.yml"), validWorkflow);
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.workflows.map((row) => row.source.workflow)).toEqual([
    ".github/workflows/-構築 checks.yml",
    ".github/workflows/a.yml",
    ".github/workflows/z.yaml",
  ]);
  expect(result.summary).toEqual({ discovered: 3, inspected: 2, failed: 1, uninspected: 0 });
  expect(result.complete).toBe(true);
  expect(await Effect.runPromise(listWorkflows({ root: repo.root }))).toEqual(result);
});

for (const remove of [".github/workflows", ".github"]) {
  it(`returns helpful empty success when ${remove} is missing`, async () => {
    await using repo = await repository({});
    await rm(join(repo.root, remove), { recursive: true });
    const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
    expect(result.summary).toEqual({ discovered: 0, inspected: 0, failed: 0, uninspected: 0 });
    expect(result.complete).toBe(true);
  });
}

it("fails with safe context when a root is invalid", async () => {
  const result = await Effect.runPromise(
    Effect.result(listWorkflows({ root: "/PRIVATE_SENTINEL/nonexistent-root" })),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "GithubActionsWorkflowError", reason: "invalid-root" },
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
});

for (const missingDirectory of [false, true]) {
  it("fails when an exact selector is unmatched, even if the default directory is missing", async () => {
    await using repo = await repository({});
    if (missingDirectory) await rm(join(repo.root, ".github"), { recursive: true });
    const result = await Effect.runPromise(
      Effect.result(listWorkflows({ root: repo.root, workflow: ".github/workflows/missing.yml" })),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "workflow-not-found" } });
  });
}

it("selects an exact unicode path without inspecting sibling files", async () => {
  await using repo = await repository({ "構築 checks.yml": validWorkflow, "bad.yml": "[" });
  const result = await Effect.runPromise(
    listWorkflows({ root: repo.root, workflow: ".github/workflows/構築 checks.yml" }),
  );
  expect(result.summary).toEqual({ discovered: 1, inspected: 1, failed: 0, uninspected: 0 });
});

for (const component of [".github", ".github/workflows"]) {
  it(`rejects symlinked discovery component ${component}`, async () => {
    await using repo = await repository({});
    await using target = await repository({ "ci.yml": validWorkflow });
    await rm(join(repo.root, component), { recursive: true });
    await symlink(join(target.root, component), join(repo.root, component));
    const result = await Effect.runPromise(Effect.result(listWorkflows({ root: repo.root })));
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe-directory" } });
  });
}

it("reports symlinks and nonregular candidates without losing healthy siblings", async () => {
  await using repo = await repository({ "ok.yml": validWorkflow });
  await symlink(join(repo.root, ".github/workflows/ok.yml"), join(repo.root, ".github/workflows/link.yml"));
  await mkdir(join(repo.root, ".github/workflows/directory.yml"));
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.summary).toEqual({ discovered: 3, inspected: 1, failed: 2, uninspected: 0 });
  expect(result.workflows.slice(0, 2).map((row) => row.diagnostics[0]?.code)).toEqual([
    "unsafe-file",
    "unsafe-file",
  ]);
});

it("escapes unsafe discovered filenames instead of emitting terminal controls", async () => {
  await using repo = await repository({ "evil\u001b[31m.yml": validWorkflow });
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.workflows[0]?.source.workflow).toBe(".github/workflows/evil\\u{1b}[31m.yml");
  expect(JSON.stringify(result)).not.toContain("\u001b");
});

it("rejects more than 100 candidates rather than silently sampling", async () => {
  await using repo = await repository(
    Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`${index}.yml`, validWorkflow])),
  );
  const result = await Effect.runPromise(Effect.result(listWorkflows({ root: repo.root })));
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "inventory-limit" } });
});

it("bounds total directory entries even when most are not workflows", async () => {
  await using repo = await repository(
    Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`${index}.txt`, ""])),
  );
  const result = await Effect.runPromise(Effect.result(listWorkflows({ root: repo.root })));
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "inventory-limit" } });
});

it("lets an exact selector bypass an overflowing directory inventory", async () => {
  await using repo = await repository(
    Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`${index}.yml`, validWorkflow])),
  );
  const result = await Effect.runPromise(
    listWorkflows({ root: repo.root, workflow: ".github/workflows/0.yml" }),
  );
  expect(result.summary.inspected).toBe(1);
});

it("reports actual UTF-8 byte overflow without parsing it", async () => {
  await using repo = await repository({ "large.yml": `#${"構".repeat(100_000)}`, "ok.yml": validWorkflow });
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.workflows[0]?.diagnostics[0]?.code).toBe("file-limit");
  expect(result.summary).toEqual({ discovered: 2, inspected: 1, failed: 1, uninspected: 0 });
});

it("preserves healthy siblings when a workflow contains invalid UTF-8", async () => {
  await using repo = await repository({ "ok.yml": validWorkflow });
  await writeFile(join(repo.root, ".github/workflows/bad.yml"), new Uint8Array([0xff, 0xfe]));
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.workflows[0]?.diagnostics[0]?.code).toBe("invalid-encoding");
  expect(result.summary).toEqual({ discovered: 2, inspected: 1, failed: 1, uninspected: 0 });
});

it("reports aggregate exhaustion with accurate uninspected rows", async () => {
  const content = `${validWorkflow}#${"x".repeat(limits.fileBytes - Buffer.byteLength(validWorkflow) - 1)}`;
  await using repo = await repository(
    Object.fromEntries(
      Array.from({ length: 34 }, (_, index) => [`${String(index).padStart(2, "0")}.yml`, content]),
    ),
  );
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.summary).toEqual({ discovered: 34, inspected: 32, failed: 0, uninspected: 2 });
  expect(result.complete).toBe(false);
  expect(result.workflows[32]?.diagnostics[0]?.code).toBe("aggregate-limit");
});

it.skipIf(process.getuid?.() === 0)("keeps unreadable files as diagnostic rows", async () => {
  await using repo = await repository({ "denied.yml": validWorkflow, "ok.yml": validWorkflow });
  await chmod(join(repo.root, ".github/workflows/denied.yml"), 0);
  const result = await Effect.runPromise(listWorkflows({ root: repo.root }));
  expect(result.summary.failed).toBe(1);
  expect(result.workflows[0]?.diagnostics[0]?.code).toBe("unsafe-file");
  expect(Result.isSuccess(await Effect.runPromise(Effect.result(listWorkflows({ root: repo.root }))))).toBe(
    true,
  );
});
