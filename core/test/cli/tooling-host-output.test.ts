import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");

test.each([
  ["text", "shell", 0],
  ["text", "argv", 0],
  ["text", "shell", 7],
  ["json", "shell", 0],
  ["yaml", "argv", 0],
] as const)(
  "prints host %s/%s output with exit %i",
  async (format, kind, exitCode) => {
    // Given an isolated app with no provider and a real shell or argv host task.
    const root = await mkdtemp(join(tmpdir(), "lando-host-output-"));
    try {
      const task =
        kind === "shell"
          ? `    env:\n      PROBE_VALUE: host-env\n    cmds:\n      - "pwd; echo $PROBE_VALUE"\n      - "echo diagnostic 1>&2; exit ${exitCode}"\n      - "printf '<%s>\\\\n'"\n`
          : '    cmd: ["printf", "<%s>\\\\n"]\n';
      await writeFile(
        join(root, ".lando.yml"),
        `name: host-output\ntooling:\n  probe:\n    service: ":host"\n${task}`,
      );
      const env = {
        ...process.env,
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
      };
      const refresh = Bun.spawn([process.execPath, cli, "app:cache:refresh", "--format=json"], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [refreshCode, refreshOut, refreshErr] = await Promise.all([
        refresh.exited,
        new Response(refresh.stdout).text(),
        new Response(refresh.stderr).text(),
      ]);
      expect(refreshCode, refreshErr || refreshOut).toBe(0);
      // When invoked through the real source CLI with literal arguments.
      const child = Bun.spawn(
        [process.execPath, cli, "probe", "two words", "$(echo injected)", `--format=${format}`],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // Then text prints each body channel once; machine formats retain the collected envelope.
      expect(code, stderr || stdout).toBe(exitCode);
      const expectedOut =
        (kind === "shell" ? `${root}\nhost-env\n` : "") +
        (exitCode === 0 ? "<two words>\n<$(echo injected)>\n" : "");
      switch (format) {
        case "text":
          expect(stdout.split(expectedOut)).toHaveLength(2);
          expect(stderr).toBe(kind === "shell" ? "diagnostic\n" : "");
          break;
        case "json":
          expect(JSON.parse(stdout)).toMatchObject({
            ok: true,
            result: { stdout: expectedOut, stderr: "diagnostic\n", exitCode },
          });
          break;
        case "yaml":
          expect(Bun.YAML.parse(stdout)).toMatchObject({
            ok: true,
            result: { stdout: expectedOut, stderr: "", exitCode },
          });
          break;
        default:
          format satisfies never;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
