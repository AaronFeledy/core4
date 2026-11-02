import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const sourceCli = resolve(import.meta.dirname, "../../bin/lando.ts");

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RouterFixture {
  readonly root: string;
  readonly cacheRoot: string;
  readonly env: Record<string, string>;
  readonly cleanup: () => Promise<void>;
}

export const makeFixture = async (name: string): Promise<RouterFixture> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `lando-tooling-router-${name}-`));
  const root = join(fixtureRoot, "app");
  const cacheRoot = join(fixtureRoot, "cache");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".lando.yml"), `name: router-${name}\n`);
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    root,
    cacheRoot,
    env: {
      ...inheritedEnv,
      PATH: "/no-such-path",
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    },
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
};

export const runProcess = async (
  command: ReadonlyArray<string>,
  fixture: RouterFixture,
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd: fixture.root,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export const runSource = (
  fixture: RouterFixture,
  argv: ReadonlyArray<string>,
  bunArgs: ReadonlyArray<string> = [],
): Promise<RunResult> => runProcess([process.execPath, ...bunArgs, sourceCli, ...argv], fixture);

export const lastEnvelope = (output: string): Record<string, unknown> => {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (line === undefined) throw new Error(`No JSON envelope in output: ${output.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object") throw new Error("Expected a JSON object envelope");
  const record = Object.fromEntries(Object.entries(parsed));
  // Streaming commands wrap the terminal envelope in a result frame.
  const frame = record._tag === "result" ? record.envelope : undefined;
  return frame !== null && typeof frame === "object" ? Object.fromEntries(Object.entries(frame)) : record;
};
