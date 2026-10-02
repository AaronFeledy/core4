import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRUSH_TOOLING_COMMAND } from "../../src/recipes/builtin/drush-command.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const runDrush = async (input: {
  readonly args: ReadonlyArray<string>;
  readonly uri?: string;
  readonly callback?: "success" | "failure" | "invalid" | "multiline";
}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-drush-uri-"));
  roots.push(root);
  await mkdir(join(root, "vendor", "bin"), { recursive: true });
  const lando = join(root, "lando");
  const drush = join(root, "vendor", "bin", "drush");
  await writeFile(
    lando,
    `#!/bin/sh
if [ "$TEST_LANDO_CALLBACK" = failure ]; then exit 7; fi
if [ "$TEST_LANDO_CALLBACK" = invalid ]; then printf '%s\\n' '{"ok":false}'; exit 0; fi
if [ "$TEST_LANDO_CALLBACK" = multiline ]; then printf '%s\\n' '{"ok":true,"result":{"targets":[{"url":"https://site.lndo.site:4444 extra"}]}}'; exit 0; fi
printf '%s\\n' '{"ok":true,"result":{"targets":[{"url":"https://site.lndo.site:4444"}]}}'
`,
  );
  await writeFile(
    drush,
    '#!/bin/sh\nprintf "URI=%s\\n" "${DRUSH_OPTIONS_URI-unset}"\nprintf "ARG=%s\\n" "$@"\n',
  );
  await chmod(lando, 0o755);
  await chmod(drush, 0o755);
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    TEST_LANDO_CALLBACK: input.callback ?? "success",
  };
  Reflect.deleteProperty(env, "DRUSH_OPTIONS_URI");
  if (input.uri !== undefined) env.DRUSH_OPTIONS_URI = input.uri;
  const proc = Bun.spawn(["sh", "-c", DRUSH_TOOLING_COMMAND, "lando-tooling", ...input.args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

(process.platform === "win32" ? describe.skip : describe)("generated Drush tooling URI", () => {
  test("uses the live routed HTTPS URL and forwards arguments unchanged", async () => {
    const result = await runDrush({ args: ["user:login", "--no-browser"] });
    expect(result).toEqual({
      stdout: "URI=https://site.lndo.site:4444\nARG=user:login\nARG=--no-browser\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("preserves an explicit environment URI even when the callback fails", async () => {
    const result = await runDrush({
      args: ["status"],
      uri: "https://custom.example:9443",
      callback: "failure",
    });
    expect(result).toEqual({
      stdout: "URI=https://custom.example:9443\nARG=status\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test.each([["--uri=https://explicit.example"], ["-lhttps://explicit.example"]])(
    "preserves an explicit Drush URI option %p without calling the callback",
    async (uriOption) => {
      const result = await runDrush({ args: ["user:login", uriOption], callback: "failure" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`ARG=${uriOption}\n`);
      expect(result.stdout).toContain("URI=unset\n");
    },
  );

  test("fails clearly instead of letting Drush print a default login URL", async () => {
    const result = await runDrush({ args: ["user:login"], callback: "failure" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not resolve this app URL for Drush.");
  });

  test("rejects whitespace-bearing callback output", async () => {
    const result = await runDrush({ args: ["user:login"], callback: "multiline" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid app URL for Drush");
  });

  test("rejects a callback response that is not an app URL", async () => {
    const result = await runDrush({ args: ["user:login"], callback: "invalid" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid app URL for Drush");
  });
});
