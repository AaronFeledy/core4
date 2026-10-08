import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guidePath = join(import.meta.dir, "../../../docs/guides/cli/everyday-commands.mdx");

const extractLandoCd = (guide: string): string => {
  const match = guide.match(/```sh\n(lando_cd\(\) \{[\s\S]*?\n\})\n```/);
  if (match?.[1] === undefined) throw new Error("expected lando_cd function in everyday-commands.mdx");
  return match[1];
};

const runInShell = async (
  shell: string,
  script: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn([shell, "-c", script], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const writeFakeLando = async (
  binDir: string,
  behavior: { readonly stdout: string; readonly exitCode: number },
): Promise<void> => {
  const script = `#!/bin/sh
printf '%s' "$(cat <<'LANDO_FAKE_EOF'
${behavior.stdout}
LANDO_FAKE_EOF
)"
exit ${behavior.exitCode}
`;
  const path = join(binDir, "lando");
  await writeFile(path, script);
  await chmod(path, 0o755);
};

const shells = [
  { name: "bash", bin: "bash" },
  { name: "dash", bin: "dash" },
] as const;

test("everyday-commands documents lando_cd, not a hyphenated function name", async () => {
  const guide = await Bun.file(guidePath).text();
  expect(guide).toContain("lando_cd()");
  expect(guide).toContain("lando_cd myapp");
  expect(guide).not.toContain("lando-cd");
});

for (const shell of shells) {
  test.skipIf(process.platform === "win32")(
    `${shell.name} lando_cd handles success, failures, and awkward roots`,
    async () => {
      const guide = await Bun.file(guidePath).text();
      const fn = extractLandoCd(guide);
      const root = await mkdtemp(join(tmpdir(), "lando-cd-"));
      const binDir = join(root, "bin");
      const start = join(root, "start");
      const okDir = join(root, "ok app");
      const dashDir = join(root, "-leading");
      await mkdir(binDir, { recursive: true });
      await mkdir(start, { recursive: true });
      await mkdir(okDir, { recursive: true });
      await mkdir(dashDir, { recursive: true });
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

      const call = async (
        stdout: string,
        exitCode: number,
        arg: string,
      ): Promise<{
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly pwd: string;
      }> => {
        await writeFakeLando(binDir, { stdout, exitCode });
        const result = await runInShell(
          shell.bin,
          `${fn}
lando_cd ${JSON.stringify(arg)}
status=$?
pwd
exit $status
`,
          env,
          start,
        );
        return { ...result, pwd: result.stdout.trim() };
      };

      try {
        const success = await call(okDir, 0, "demo");
        expect(success.exitCode).toBe(0);
        expect(success.pwd).toBe(okDir);

        const leadingDash = await call(dashDir, 0, "dashy");
        expect(leadingDash.exitCode).toBe(0);
        expect(leadingDash.pwd).toBe(dashDir);

        const failed = await call("", 3, "demo");
        expect(failed.exitCode).toBe(3);
        expect(failed.pwd).toBe(start);

        const empty = await call("", 0, "demo");
        expect(empty.exitCode).toBe(1);
        expect(empty.stderr).toContain("no app root for demo");
        expect(empty.pwd).toBe(start);

        const nul = await call("null", 0, "demo");
        expect(nul.exitCode).toBe(1);
        expect(nul.stderr).toContain("no app root for demo");
        expect(nul.pwd).toBe(start);

        const multiple = await call(`${okDir}\n${dashDir}`, 0, "dup");
        expect(multiple.exitCode).toBe(1);
        expect(multiple.stderr).toContain("multiple apps named dup");
        expect(multiple.stderr).toContain("--path");
        expect(multiple.pwd).toBe(start);

        const stale = await call(join(root, "gone"), 0, "demo");
        expect(stale.exitCode).not.toBe(0);
        expect(stale.pwd).toBe(start);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
