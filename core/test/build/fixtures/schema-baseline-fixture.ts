import { expect } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const CHECK_MODULE_PATH = new URL("../../../../scripts/check-schema-compatibility.ts", import.meta.url)
  .href;
const BASELINE_MODULE_PATH = new URL("../../../../scripts/schema-compatibility-baseline.ts", import.meta.url)
  .href;
const ARTIFACTS_MODULE_PATH = new URL(
  "../../../../scripts/schema-compatibility-artifacts.ts",
  import.meta.url,
).href;
const GENERATOR_PATH = "scripts/build-schema-snapshot.ts";
const roots: string[] = [];

export type SchemaArtifactFamily = "sdk" | "command";

export interface Fixture {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly historicalRef: string;
  readonly baseRef: string;
}

export interface RegenerationRequest {
  readonly baseRef: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

export class FixtureCommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(`${command} failed: ${stderr}`);
  }
}

const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

export const writeFixtureFile = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
};

export const runFixtureCommand = async (
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  command: ReadonlyArray<string>,
): Promise<string> => {
  const child = Bun.spawn({ cmd: [...command], cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    text(child.stdout),
    text(child.stderr),
  ]);
  if (exitCode !== 0) throw new FixtureCommandError(command.join(" "), stderr.trim());
  return stdout.trim();
};

export const git = (
  fixture: Pick<Fixture, "root" | "env">,
  ...args: ReadonlyArray<string>
): Promise<string> => runFixtureCommand(fixture.root, fixture.env, ["git", ...args]);

export const commit = async (fixture: Pick<Fixture, "root" | "env">, message: string): Promise<string> => {
  await git(fixture, "add", ".");
  await git(fixture, "commit", "-m", message);
  return git(fixture, "rev-parse", "HEAD");
};

const generator = (version: "alpha" | "beta"): string => `
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist/schemas", { recursive: true });
await mkdir("dist/command-schemas", { recursive: true });
await writeFile("dist/schemas/index.json", JSON.stringify([{ id: "Fixture", jsonSchemaPath: "dist/schemas/fixture.json" }]));
await writeFile("dist/schemas/fixture.json", JSON.stringify({ type: "string", const: "${version}" }));
await writeFile("dist/command-schemas/index.json", JSON.stringify({ fixture: "dist/command-schemas/fixture.json" }));
await writeFile("dist/command-schemas/fixture.json", JSON.stringify({ type: "string", const: "${version}" }));
if (process.env.FAIL_GENERATOR === "1") process.exit(23);
`;

const isolatedGitEnv = async (root: string): Promise<Readonly<Record<string, string | undefined>>> => {
  const emptyConfig = join(root, "empty.gitconfig");
  await writeFile(emptyConfig, "", "utf8");
  return {
    ...Bun.env,
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_AUTHOR_NAME: "Lando Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Lando Test",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
  };
};

export const makeRepository = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "lando-schema-baseline-"));
  roots.push(root);
  const env = await isolatedGitEnv(root);
  const fixture = { root, env };
  await git(fixture, "init", "-b", "main");
  await writeFixtureFile(root, ".gitignore", "dist/\n");
  await writeFixtureFile(
    root,
    "package.json",
    '{"name":"schema-fixture","private":true,"scripts":{"codegen:schema-snapshot":"bun run scripts/build-schema-snapshot.ts"}}\n',
  );
  await runFixtureCommand(root, env, ["bun", "install", "--lockfile-only"]);
  const historicalRef = await commit(fixture, "historical fixture");
  await writeFixtureFile(root, GENERATOR_PATH, generator("alpha"));
  const baseRef = await commit(fixture, "alpha generator");
  await writeFixtureFile(root, "bun.lock", "malformed head lockfile\n");
  await writeFixtureFile(root, GENERATOR_PATH, generator("beta"));
  await commit(fixture, "beta generator");
  return { root, env, historicalRef, baseRef };
};

export const field = (value: unknown, name: string): unknown => {
  if (value === null || typeof value !== "object" || !(name in value)) {
    throw new FixtureCommandError("read regeneration result", `missing ${name}`);
  }
  return Reflect.get(value, name);
};

const moduleExport = async (path: string, name: string): Promise<unknown> => field(await import(path), name);

export const callExport = async (
  path: string,
  name: string,
  args: ReadonlyArray<unknown>,
): Promise<unknown> => {
  const exported = await moduleExport(path, name);
  if (typeof exported !== "function") throw new FixtureCommandError(path, `missing ${name} export`);
  return Reflect.apply(exported, undefined, args);
};

export const regenerate = (request: RegenerationRequest): Promise<unknown> =>
  callExport(BASELINE_MODULE_PATH, "regenerateBaseSchemaArtifacts", [request]);

export const unavailableFamilies = (result: unknown): ReadonlyArray<SchemaArtifactFamily> => {
  const value = field(result, "unavailableFamilies");
  if (!Array.isArray(value) || !value.every((entry) => entry === "sdk" || entry === "command")) {
    throw new FixtureCommandError("read regeneration result", "invalid unavailableFamilies");
  }
  return value;
};

export const captureFailure = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
};

export const expectInputFailure = async (failure: unknown, baseRef: string): Promise<void> => {
  const errorType = await moduleExport(ARTIFACTS_MODULE_PATH, "SchemaCompatibilityInputError");
  if (typeof errorType !== "function") {
    throw new FixtureCommandError(ARTIFACTS_MODULE_PATH, "missing SchemaCompatibilityInputError export");
  }
  expect(failure).toBeInstanceOf(errorType);
  if (!(failure instanceof errorType)) {
    throw new FixtureCommandError("regenerate baseline", "expected SchemaCompatibilityInputError");
  }
  expect(`${field(failure, "message")} ${field(failure, "detail") ?? ""}`).toContain(baseRef);
};

export const worktreeCount = async (fixture: Fixture): Promise<number> =>
  (await git(fixture, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

type GitShimOptions =
  | { readonly mode: "fail-ls-tree" }
  | {
      readonly mode: "move-ref-after-resolution";
      readonly mutableRef: string;
      readonly mutationTarget: string;
    };

export interface GitShim {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logPath: string;
}

export const installGitShim = async (fixture: Fixture, options: GitShimOptions): Promise<GitShim> => {
  const actualGit = Bun.which("git");
  if (actualGit === null) throw new FixtureCommandError("locate git", "git executable is unavailable");
  const bin = join(fixture.root, "shim-bin");
  const shim = join(bin, "git");
  const logPath = join(fixture.root, "git-commands.log");
  await mkdir(bin, { recursive: true });
  await writeFile(
    shim,
    `#!/usr/bin/env bash
set -euo pipefail
actual_git=${JSON.stringify(actualGit)}
printf '%s\\n' "$*" >> "$SCHEMA_FIXTURE_GIT_LOG"
if [[ "\${SCHEMA_FIXTURE_GIT_MODE}" == "fail-ls-tree" && "\${1:-}" == "ls-tree" ]]; then
  printf 'simulated ls-tree failure\\n' >&2
  exit 17
fi
if [[ "\${SCHEMA_FIXTURE_GIT_MODE}" == "move-ref-after-resolution" && "\${1:-}" == "rev-parse" ]]; then
  output=$("$actual_git" "$@")
  "$actual_git" update-ref "$SCHEMA_FIXTURE_MUTABLE_REF" "$SCHEMA_FIXTURE_MUTATION_TARGET"
  printf '%s\\n' "$output"
  exit 0
fi
exec "$actual_git" "$@"
`,
    "utf8",
  );
  await chmod(shim, 0o755);
  const modeEnv =
    options.mode === "fail-ls-tree"
      ? {}
      : {
          SCHEMA_FIXTURE_MUTABLE_REF: options.mutableRef,
          SCHEMA_FIXTURE_MUTATION_TARGET: options.mutationTarget,
        };
  return {
    logPath,
    env: {
      ...fixture.env,
      ...modeEnv,
      PATH: `${bin}${delimiter}${fixture.env.PATH ?? ""}`,
      SCHEMA_FIXTURE_GIT_LOG: logPath,
      SCHEMA_FIXTURE_GIT_MODE: options.mode,
    },
  };
};

export const cleanupRepositories = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
};
