import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BASELINE_MODULE_PATH = "../../../scripts/schema-compatibility-baseline.ts";
const CHECK_MODULE_PATH = "../../../scripts/check-schema-compatibility.ts";
const ARTIFACTS_MODULE_PATH = "../../../scripts/schema-compatibility-artifacts.ts";
const GENERATOR_PATH = "scripts/build-schema-snapshot.ts";
const roots: string[] = [];
type SchemaArtifactFamily = "sdk" | "command";

interface Fixture {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly historicalRef: string;
  readonly baseRef: string;
}

interface RegenerationRequest {
  readonly baseRef: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

class FixtureCommandError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(`${command} failed: ${stderr}`);
  }
}

const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

const write = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
};

const run = async (
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

const git = (fixture: Pick<Fixture, "root" | "env">, ...args: ReadonlyArray<string>): Promise<string> =>
  run(fixture.root, fixture.env, ["git", ...args]);

const commit = async (fixture: Pick<Fixture, "root" | "env">, message: string): Promise<string> => {
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

const makeRepository = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "lando-schema-baseline-"));
  roots.push(root);
  const env = await isolatedGitEnv(root);
  const fixture = { root, env };
  await git(fixture, "init", "-b", "main");
  await write(root, ".gitignore", "dist/\n");
  await write(
    root,
    "package.json",
    '{"name":"schema-fixture","private":true,"scripts":{"codegen:schema-snapshot":"bun run scripts/build-schema-snapshot.ts"}}\n',
  );
  await run(root, env, ["bun", "install", "--lockfile-only"]);
  const historicalRef = await commit(fixture, "historical fixture");
  await write(root, GENERATOR_PATH, generator("alpha"));
  const baseRef = await commit(fixture, "alpha generator");
  await write(root, "bun.lock", "malformed head lockfile\n");
  await write(root, GENERATOR_PATH, generator("beta"));
  await commit(fixture, "beta generator");
  return { root, env, historicalRef, baseRef };
};

const field = (value: unknown, name: string): unknown => {
  if (value === null || typeof value !== "object" || !(name in value)) {
    throw new FixtureCommandError("read regeneration result", `missing ${name}`);
  }
  const result: unknown = Reflect.get(value, name);
  return result;
};

const moduleExport = async (path: string, name: string): Promise<unknown> => field(await import(path), name);

const callExport = async (path: string, name: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
  const exported = await moduleExport(path, name);
  if (typeof exported !== "function") throw new FixtureCommandError(path, `missing ${name} export`);
  return Reflect.apply(exported, undefined, args);
};

const regenerate = (request: RegenerationRequest): Promise<unknown> =>
  callExport(BASELINE_MODULE_PATH, "regenerateBaseSchemaArtifacts", [request]);

const unavailableFamilies = (result: unknown): ReadonlyArray<SchemaArtifactFamily> => {
  const value = field(result, "unavailableFamilies");
  if (!Array.isArray(value) || !value.every((entry) => entry === "sdk" || entry === "command")) {
    throw new FixtureCommandError("read regeneration result", "invalid unavailableFamilies");
  }
  return value;
};

const captureFailure = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
};

const expectInputFailure = async (failure: unknown, baseRef: string): Promise<void> => {
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

const worktreeCount = async (fixture: Fixture): Promise<number> =>
  (await git(fixture, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isolated schema compatibility baseline regeneration", () => {
  test("regenerates both artifact families with the base generator and cleans its worktree", async () => {
    // Given: alpha at the base commit and a beta generator in the head checkout.
    const fixture = await makeRepository();

    // When: the base artifacts are regenerated.
    const result = await regenerate({ baseRef: fixture.baseRef, env: fixture.env, repoRoot: fixture.root });

    // Then: both artifacts came from alpha and the temporary worktree was removed.
    const artifacts = field(result, "artifacts");
    expect(artifacts).toBeInstanceOf(Map);
    if (!(artifacts instanceof Map)) throw new FixtureCommandError("read artifacts", "expected Map");
    expect(field(field(artifacts.get("schema:Fixture"), "schema"), "const")).toBe("alpha");
    expect(field(field(artifacts.get("command:fixture"), "schema"), "const")).toBe("alpha");
    expect(unavailableFamilies(result)).toEqual([]);
    expect(await worktreeCount(fixture)).toBe(1);
  }, 30_000);

  test("fails closed when base dependency installation fails and cleans its worktree", async () => {
    // Given: a zero-dependency base whose install lifecycle exits nonzero.
    const fixture = await makeRepository();
    await write(
      fixture.root,
      "package.json",
      '{"name":"schema-fixture","private":true,"scripts":{"codegen:schema-snapshot":"bun run scripts/build-schema-snapshot.ts","preinstall":"exit 19"}}\n',
    );
    await rm(join(fixture.root, "bun.lock"));
    await run(fixture.root, fixture.env, ["bun", "install", "--lockfile-only", "--ignore-scripts"]);
    const baseRef = await commit(fixture, "failing install");

    // When: regeneration attempts to install the base checkout.
    const failure = await captureFailure(() =>
      regenerate({ baseRef, env: fixture.env, repoRoot: fixture.root }),
    );

    // Then: a typed, base-specific failure is returned and no worktree leaks.
    await expectInputFailure(failure, baseRef);
    expect(await worktreeCount(fixture)).toBe(1);
  }, 30_000);

  test("fails closed when the base generator fails and cleans its worktree", async () => {
    // Given: a valid base generator configured to exit nonzero.
    const fixture = await makeRepository();
    const env = { ...fixture.env, FAIL_GENERATOR: "1" };

    // When: regeneration executes the base generator.
    const failure = await captureFailure(() =>
      regenerate({ baseRef: fixture.baseRef, env, repoRoot: fixture.root }),
    );

    // Then: a typed, base-specific failure is returned and no worktree leaks.
    await expectInputFailure(failure, fixture.baseRef);
    expect(await worktreeCount(fixture)).toBe(1);
  }, 30_000);

  test("skips both families exactly when history predates the generator without a worktree", async () => {
    // Given: a historical base with no schema snapshot generator and one current surface per family.
    const fixture = await makeRepository();
    const current = new Map([
      ["schema:Fixture", { surface: "schema:Fixture", polarity: "strict" as const, schema: {} }],
      ["command:fixture", { surface: "command:fixture", polarity: "output" as const, schema: {} }],
    ]);
    const countBefore = await worktreeCount(fixture);

    // When: the historical base is regenerated.
    const result = await regenerate({
      baseRef: fixture.historicalRef,
      env: fixture.env,
      repoRoot: fixture.root,
    });

    // Then: sdk and command skips each count one surface, without creating a worktree.
    const artifacts = field(result, "artifacts");
    expect(artifacts).toBeInstanceOf(Map);
    if (!(artifacts instanceof Map)) throw new FixtureCommandError("read artifacts", "expected Map");
    expect(artifacts.size).toBe(0);
    const families = unavailableFamilies(result);
    expect(families).toEqual(["sdk", "command"]);
    const notices = await callExport(CHECK_MODULE_PATH, "skippedFamilyNotices", [
      current,
      fixture.historicalRef,
      families,
    ]);
    expect(notices).toEqual([
      {
        family: "sdk",
        count: 1,
        generatorPath: "scripts/build-schema-snapshot.ts",
        baseRef: fixture.historicalRef,
      },
      {
        family: "command",
        count: 1,
        generatorPath: "scripts/build-schema-snapshot.ts",
        baseRef: fixture.historicalRef,
      },
    ]);
    expect(await worktreeCount(fixture)).toBe(countBefore);
  }, 30_000);

  test("rejects an unresolvable base ref without creating a worktree", async () => {
    // Given: an isolated repository and a base ref that does not resolve.
    const fixture = await makeRepository();
    const baseRef = "refs/heads/missing-base";
    const countBefore = await worktreeCount(fixture);

    // When: regeneration resolves the missing base.
    const failure = await captureFailure(() =>
      regenerate({ baseRef, env: fixture.env, repoRoot: fixture.root }),
    );

    // Then: a typed, base-specific failure is returned without creating a worktree.
    await expectInputFailure(failure, baseRef);
    expect(await worktreeCount(fixture)).toBe(countBefore);
  }, 30_000);
});
