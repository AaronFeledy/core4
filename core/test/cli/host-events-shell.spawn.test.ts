import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
let root = "";

const runLando = async (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const proc = Bun.spawn({
    cmd: [process.execPath, join(repoRoot, "core/bin/lando.ts"), ...args],
    cwd: join(root, "app"),
    env: {
      ...process.env,
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_STATE_ROOT: join(root, "state"),
      LANDO_LOG_LEVEL: "none",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { exitCode, stdout };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-host-events-shell-"));
  await mkdir(join(root, "conf"), { recursive: true });
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(
    join(root, "conf", "config.yml"),
    'hostEvents:\n  pre-start:\n    - cmd: "echo starting >&2"\n      service: ":host"\n',
  );
  await writeFile(join(root, "app", ".lando.yml"), "name: host-events-shell\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a host-wide step Bun Shell can't run", () => {
  test("config validate reports it at the step's cmd", async () => {
    const result = await runLando(["config", "validate", "--format=json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"path":["hostEvents","pre-start",0,"cmd"]');
    expect(result.stdout).toContain("Bun Shell needs an explicit source descriptor in >&2.");
  });

  test("commands that only read config keep working", async () => {
    const result = await runLando(["app:config", "--format=json"]);
    expect(result.exitCode).toBe(0);
  });

  test("planning an app stops before it changes anything", async () => {
    const result = await runLando(["app:cache:refresh", "--format=json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"_tag":"LandofileValidationError"');
    expect(result.stdout).toContain("landofile.host-shell");
  });

  test("a nested Lando that skips host events plans normally", async () => {
    const result = await runLando(["app:cache:refresh", "--format=json"], { LANDO_HOST_EVENT: "1" });
    expect(result.exitCode).toBe(0);
  });
});
