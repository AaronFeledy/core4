import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import type { LandoEvent } from "@lando/sdk/services";
import { runCli } from "../../src/cli/index.ts";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const canary = "private-gate-token-927";
const cases = [
  [],
  ["--renderer"],
  [`--renderer=${canary}`, "--format=json"],
  [`--renderer=${canary}`, "--json"],
  ["--format"],
  ["--format=csv"],
  ["--format=table"],
  ["--renderer=plain", `--format=${canary}`],
  ["--json"],
  ["--help"],
  ["--version"],
] as const;

test.each(
  ["bad", "retired"]
    .flatMap((name) =>
      cases.flatMap((tail) => [
        {
          name,
          argv: [name, ...tail],
          machine: tail.some((token) => token === "--json" || token === "--format=json"),
        },
        { name, argv: ["--format=json", name, ...tail], machine: true },
      ]),
    )
    .concat(
      ["bad", "retired"].map((name) => ({ name, argv: ["help", name, "--format=json"], machine: true })),
    ),
)(
  "refuses $argv before command selections or result-key listing without effects",
  async ({ name, argv, machine }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-tooling-refusal-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: refusal
tooling:
  bad:
    service: :host
    cmd: touch body-effect
    flags:
      renderer:
        sensitive: true
        alias: q
      other:
        alias: q
    vars:
      value:
        sh: touch var-effect
  retired:
    disabled: true
    service: :host
    cmd: touch body-effect
events:
  pre-bad:
    - cmd: touch hook-effect
      service: :host
  pre-retired:
    - cmd: touch hook-effect
      service: :host
`,
      );
      const child = Bun.spawn([process.execPath, cli, ...argv], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
        },
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const tag = name === "bad" ? "ToolingCompileError" : "ToolingDisabledError";
      expect(code, stdout + stderr).toBe(1);
      expect(stdout + stderr).not.toContain(canary);
      if (machine)
        expect(JSON.parse(stdout)).toMatchObject({
          ok: false,
          error: { _tag: tag, source: { path: join(root, ".lando.yml"), task: name } },
        });
      else expect(stderr).toContain(tag);
      for (const path of ["body-effect", "var-effect", "hook-effect"])
        expect(await Bun.file(join(root, path)).exists(), path).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "protects supplied strings in refusal diagnostics and observed events (disabled=$disabled)",
  async (disabled) => {
    const root = await mkdtemp(join(tmpdir(), "lando-refusal-observer-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: refusal-observer
tooling:
  bad:
    disabled: ${disabled}
    service: :host
    cmd: touch body-effect
    flags:
      renderer:
        sensitive: true
        alias: q
      ${canary}:
        alias: q
`,
      );
      const io = createBufferedRendererIO();
      const events: LandoEvent[] = [];
      const statuses: number[] = [];
      await runCli({
        rootUrl: "",
        argv: ["bad", `--renderer=${canary}`, "--json"],
        context: {
          cwd: root,
          env: {
            ...process.env,
            LANDO_USER_CONF_ROOT: join(root, "conf"),
            LANDO_USER_DATA_ROOT: join(root, "data"),
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
          },
          io,
          setExitCode: (code) => {
            statuses.push(code);
          },
          observeEvent: (event) => {
            events.push(event);
          },
        },
      });
      expect(statuses).toEqual([1]);
      expect(JSON.parse(io.stdout())).toMatchObject({
        ok: false,
        error: { _tag: disabled ? "ToolingDisabledError" : "ToolingCompileError" },
      });
      expect(io.stdout() + io.stderr() + JSON.stringify(events)).not.toContain(canary);
      expect(events.filter((event) => event._tag.startsWith("cli-app:bad-"))).toEqual([]);
      expect(await Bun.file(join(root, "body-effect")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
