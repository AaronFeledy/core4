import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isErrnoCode } from "@lando/sdk/errors";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");

const runCli = async (cwd: string, env: NodeJS.ProcessEnv, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const envelope: unknown = JSON.parse(stdout);
  return { exit, envelope };
};

const withFreshCertsApp = async (
  body: (input: {
    readonly appRoot: string;
    readonly data: string;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-certs-before-setup-"));
  const appRoot = join(root, "app");
  try {
    await mkdir(appRoot, { recursive: true });
    await writeFile(
      join(appRoot, ".lando.yml"),
      "name: certs-before-setup\nservices:\n  web:\n    type: nginx\n    certs: true\n",
    );
    const data = join(root, "data");
    await body({
      appRoot,
      data,
      env: {
        ...process.env,
        LANDO_USER_CONF_ROOT: join(root, "conf"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_DATA_ROOT: data,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("planning a certs: true app with fresh roots and no setup never needs a certificate authority", async () => {
  await withFreshCertsApp(async ({ appRoot, data, env }) => {
    // When: reading config and running the full app planner
    const config = await runCli(appRoot, env, ["app:config", "get", "services", "--format=json"]);
    const planned = await runCli(appRoot, env, ["app:cache:refresh", "--format=json"]);

    // Then: both succeed and planning wrote no certificate material
    expect(config).toMatchObject({
      exit: 0,
      envelope: { ok: true, result: { value: { web: { certs: true } } } },
    });
    expect(planned).toMatchObject({ exit: 0, envelope: { ok: true } });
    expect(
      await readdir(data).catch((cause) => {
        if (isErrnoCode(cause, "ENOENT")) return [];
        throw cause;
      }),
    ).not.toContain("certs");
  });
});

test("an unknown command in a certs: true app with fresh roots reports the unknown command", async () => {
  await withFreshCertsApp(async ({ appRoot, env }) => {
    // When: dispatch plans the app to look for tooling named by the token
    const unknown = await runCli(appRoot, env, ["notacommand", "--format=json"]);
    // Then: the failure is the unknown command, not a certificate-authority planning error
    expect(unknown.envelope).toMatchObject({ ok: false, error: { _tag: "UnknownCommandError" } });
  });
});
