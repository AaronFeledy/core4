import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { ensureCompiledCli } from "../../_support/compiled-cli.ts";
import { startGitHttpServer } from "../../_support/git-http-server.ts";
import { createGitRepository } from "../../_support/git-repository.ts";
import { withEnvVar } from "../../_support/temp-cwd.ts";
import { stubContainerHelperDir } from "./container-helper-stubs.ts";

export const ORIGINAL = "services:\n  web:\n    type: php\n";
export const CHANGED = "services:\n  web:\n    type: node\n";
export const Lock = Schema.Struct({
  includes: Schema.Array(
    Schema.Struct({ source: Schema.String, version: Schema.String, resolved: Schema.String }),
  ),
});

export const compiledCli = async (): Promise<string> => {
  if (process.env.LANDO_TEST_COMPILED_CLI !== undefined) return ensureCompiledCli();
  const helpers = await stubContainerHelperDir();
  try {
    return await withEnvVar("LANDO_CONTAINER_HELPER_DIR", helpers, ensureCompiledCli);
  } finally {
    await rm(helpers, { recursive: true, force: true });
  }
};

export const withApp = async (
  body: (app: {
    readonly root: string;
    readonly appRoot: string;
    readonly store: string;
    readonly spawn: (args: readonly string[]) => Bun.Subprocess<"ignore", "pipe", "pipe">;
    readonly run: (args: readonly string[], exitCode?: number) => Promise<string>;
    readonly include: (url: string, version?: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-source-acceptance-"));
  try {
    const appRoot = join(root, "app");
    await mkdir(appRoot);
    const gitConfig = join(root, "gitconfig");
    await writeFile(gitConfig, "[protocol]\n version = 2\n[http]\n proxy =\n");
    const env = {
      ...process.env,
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_RENDERER: "plain",
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    const cli = await compiledCli();
    const spawn = (args: readonly string[]) =>
      Bun.spawn([cli, ...args, "--format=json"], {
        cwd: appRoot,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    const run = async (args: readonly string[], expected = 0): Promise<string> => {
      const child = spawn(args);
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, `${args.join(" ")}\n${stdout}\n${stderr}`).toBe(expected);
        return stdout;
      } finally {
        clearTimeout(deadline);
      }
    };
    await body({
      root,
      appRoot,
      spawn,
      run,
      store: join(root, "cache", "sources"),
      include: (url, version = "v1") =>
        writeFile(
          join(appRoot, ".lando.yml"),
          `name: source-acceptance\nincludes:\n  - source: ${url}\n    path: fragment.yml\n    version: ${version}\n`,
        ),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const withRemote = async (
  body: (fixture: {
    readonly app: Parameters<Parameters<typeof withApp>[0]>[0];
    readonly server: ReturnType<typeof startGitHttpServer>;
    readonly repository: Awaited<ReturnType<typeof createGitRepository>>;
    readonly commit: string;
    readonly url: string;
  }) => Promise<void>,
): Promise<void> =>
  withApp(async (app) => {
    const repository = await createGitRepository(app.root, "remote.git", [
      { kind: "commit", message: "original", files: { "fragment.yml": ORIGINAL } },
      { kind: "git", args: ["tag", "-a", "v1", "-m", "annotated pin"] },
    ]);
    const commit = repository.commits[0];
    if (commit === undefined) throw new Error("Missing fixture commit");
    const server = startGitHttpServer(app.root);
    try {
      await body({ app, repository, commit, server, url: server.url("remote.git") });
    } finally {
      await server.stop();
    }
  });

export const result = <A>(schema: Schema.ConstraintDecoder<A>, output: string): A => {
  const envelope = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown })),
  )(output);
  return Schema.decodeUnknownSync(schema)(envelope.result);
};
