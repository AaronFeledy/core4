import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

const lintApp = (cwd: string) =>
  Effect.runPromise(
    appConfigLint({ cwd }).pipe(Effect.provide(Layer.merge(PluginRegistryLayer.layer, BunFileSystem.layer))),
  );

test("warns when a double-quoted env value decodes differently from its raw text", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-escape-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-escape\nenv_file: [runtime.env]\n");
    await writeFile(join(root, "runtime.env"), 'PATH="C:\\new"\n');

    const result = await lintApp(root);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([
      {
        path: ["env_file", 0],
        line: 1,
        message: expect.stringContaining("decodes differently from its raw text"),
        suggestion: expect.stringContaining("single quotes"),
      },
    ]);
    expect(result.warnings?.[0]?.message).toContain("PATH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warns when an env value contains ${ without failing the lint", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-interp-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-interp\nenv_file: [runtime.env]\n");
    await writeFile(join(root, "runtime.env"), "TOKEN=${SECRET}\n");

    const result = await lintApp(root);

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([
      {
        path: ["env_file", 0],
        line: 1,
        message: expect.stringContaining("${"),
        suggestion: expect.stringContaining("{{ env.* }}"),
      },
    ]);
    expect(result.warnings?.[0]?.suggestion).toContain("$$");
    expect(result.warnings?.[0]?.suggestion).toContain("single quotes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats a bare NAME env line as an error with environment remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-env-lint-bare-"));
  try {
    await writeFile(join(root, ".lando.yml"), "name: env-lint-bare\nenv_file: [runtime.env]\n");
    await writeFile(join(root, "runtime.env"), "NAME\n");

    const result = await lintApp(root);

    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      {
        path: ["env_file", 0],
        line: 1,
        message: expect.stringContaining("Expected KEY=VALUE."),
        suggestion: 'environment: { NAME: "{{ env.NAME }}" }',
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
