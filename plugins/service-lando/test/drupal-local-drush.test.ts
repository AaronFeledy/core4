import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drupalLocalLauncher } from "../src/services/drupal-local-launcher.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const runDrush = async (input: {
  readonly args: ReadonlyArray<string>;
  readonly uri?: string;
  readonly callback?: "success" | "failure" | "invalid" | "multiline";
  readonly missing?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "lando-drush-uri-"));
  roots.push(root);
  await mkdir(join(root, "vendor", "bin"), { recursive: true });
  const cwd = join(root, "web", "modules");
  await mkdir(cwd, { recursive: true });
  const lando = join(root, "lando");
  const drush = join(root, "vendor", "bin", "drush");
  await writeFile(
    lando,
    `#!/bin/sh
: > "$0.called"
[ "$#" -eq 3 ] && [ "$1" = app:open ] && [ "$2" = --print ] && [ "$3" = --format=json ] || exit 8
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
  await chmod(drush, input.missing ? 0o644 : 0o755);
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    LANDO_APP_ROOT: root,
    LANDO_WEBROOT: join(root, "web"),
    TEST_LANDO_CALLBACK: input.callback ?? "success",
  };
  Reflect.deleteProperty(env, "DRUSH_OPTIONS_URI");
  if (input.uri !== undefined) env.DRUSH_OPTIONS_URI = input.uri;
  const proc = Bun.spawn([...drupalLocalLauncher, "drush", ...input.args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, callbackInvoked: await Bun.file(`${lando}.called`).exists() };
};

(process.platform === "win32" ? describe.skip : describe)("Drupal launcher Drush URI", () => {
  test("runs from a subdirectory with the live routed HTTPS URL and unchanged argv", async () => {
    const result = await runDrush({ args: ["user:login", "--no-browser"] });
    expect(result).toEqual({
      stdout: "URI=https://site.lndo.site:4444\nARG=user:login\nARG=--no-browser\n",
      stderr: "",
      exitCode: 0,
      callbackInvoked: true,
    });
  });

  test("resolves the app URL when -l only appears after --", async () => {
    const result = await runDrush({ args: ["php:eval", "--", "-lfoo"] });
    expect(result).toEqual({
      stdout: "URI=https://site.lndo.site:4444\nARG=php:eval\nARG=--\nARG=-lfoo\n",
      stderr: "",
      exitCode: 0,
      callbackInvoked: true,
    });
  });

  test("preserves an explicit environment URI without calling the callback", async () => {
    const result = await runDrush({
      args: ["status"],
      uri: "https://custom.example:9443",
      callback: "failure",
    });
    expect(result).toEqual({
      stdout: "URI=https://custom.example:9443\nARG=status\n",
      stderr: "",
      exitCode: 0,
      callbackInvoked: false,
    });
  });

  test.each(
    [
      ["--uri=https://explicit.example"],
      ["-lhttps://explicit.example"],
      ["--uri", "https://explicit.example"],
      ["-l", "https://explicit.example"],
    ].map((options) => ({ options })),
  )(
    "preserves an explicit Drush URI option %p without calling the callback",
    async ({ options: uriOptions }) => {
      const args = ["user:login", ...uriOptions];
      const result = await runDrush({ args, callback: "failure" });
      expect(result).toEqual({
        stdout: ["URI=unset", ...args.map((arg) => `ARG=${arg}`), ""].join("\n"),
        stderr: "",
        exitCode: 0,
        callbackInvoked: false,
      });
    },
  );

  test("gives the site install hint before attempting URI resolution", async () => {
    const result = await runDrush({ args: ["status"], missing: true, callback: "failure" });
    expect(result).toEqual({
      stdout: "",
      stderr: "vendor/bin/drush is not installed. Run lando composer require drush/drush.\n",
      exitCode: 1,
      callbackInvoked: false,
    });
  });

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
