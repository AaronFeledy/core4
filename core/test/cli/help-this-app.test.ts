import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "../../src/testing/engine-layers";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

type RunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};

const runCli = async (argv: ReadonlyArray<string>, options: RunOptions = {}) => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...argv],
    cwd: options.cwd ?? repoRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const makeAppFixture = async (): Promise<{
  readonly root: string;
  readonly cacheRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "lando-this-app-help-"));
  const root = fixtureRoot;
  const cacheRoot = join(fixtureRoot, "cache");
  await writeFile(join(root, ".lando.yml"), "name: native-help\n");
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    root,
    cacheRoot,
    env: {
      ...inheritedEnv,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    },
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
};

const writeFreshCache = async (fixture: Awaited<ReturnType<typeof makeAppFixture>>): Promise<void> => {
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: {
        name: "native-help",
        commandAliases: { custom: { hi: "app:greet" } },
      },
      entries: [{ id: "app:greet", summary: "Echo hello", hidden: false }],
      cwd: fixture.root,
      cacheRoot: fixture.cacheRoot,
    }),
  );
};

const sectionBody = (text: string, heading: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length === 0 && body.length > 0) break;
    if (line.length > 0 && line === line.toUpperCase() && !line.startsWith(" ")) break;
    body.push(line);
  }
  return body.join("\n");
};

describe("cwd-aware THIS APP overlay", () => {
  test("Given a fresh cache and custom hi alias, when help runs, then THIS APP lists hi and COMMON does not", async () => {
    // Given
    const fixture = await makeAppFixture();
    try {
      await writeFreshCache(fixture);

      // When
      const result = await runCli(["help"], { cwd: fixture.root, env: fixture.env });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("THIS APP");
      expect(result.stdout).toContain("hi");
      expect(sectionBody(result.stdout, "COMMON")).not.toMatch(/(?:^|\s)hi(?:\s|$)/);
      expect(sectionBody(result.stdout, "THIS APP")).toMatch(/(?:^|\s)hi(?:\s|$)/);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Given an app cwd without a cache, when help runs, then THIS APP is omitted", async () => {
    // Given
    const fixture = await makeAppFixture();
    try {
      // When
      const result = await runCli(["help"], { cwd: fixture.root, env: fixture.env });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("THIS APP");
    } finally {
      await fixture.cleanup();
    }
  });

  test("Given a non-app cwd, when bin/lando.ts --help runs, then THIS APP is omitted", async () => {
    // Given
    const cwd = await mkdtemp(join(tmpdir(), "lando-this-app-none-"));
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    try {
      // When
      const result = await runCli(["--help"], {
        cwd,
        env: {
          ...inheritedEnv,
          LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
          LANDO_USER_DATA_ROOT: join(cwd, "data"),
          LANDO_USER_CONF_ROOT: join(cwd, "conf"),
        },
      });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("COMMON");
      expect(result.stdout).not.toContain("THIS APP");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("Given a fresh cache, when JSON help runs, then thisApp and all include the tooling row", async () => {
    // Given
    const fixture = await makeAppFixture();
    try {
      await writeFreshCache(fixture);

      // When
      const result = await runCli(["help", "--format=json"], { cwd: fixture.root, env: fixture.env });
      const envelope: unknown = JSON.parse(result.stdout);

      // Then
      expect(result.exitCode).toBe(0);
      expect(envelope).toMatchObject({
        apiVersion: "v4",
        command: "cli:help",
        ok: true,
      });
      const resultBody = (
        envelope as {
          result: {
            sections: { thisApp: ReadonlyArray<{ canonicalId: string; source: string }> };
            all: ReadonlyArray<{ canonicalId: string; source: string }>;
          };
        }
      ).result;
      expect(resultBody.sections.thisApp.some((row) => row.canonicalId === "app:greet")).toBe(true);
      expect(resultBody.all.some((row) => row.canonicalId === "app:greet" && row.source === "tooling")).toBe(
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("Given a fresh cache, when help targets tooling names, then tooling help renders", async () => {
    // Given
    const fixture = await makeAppFixture();
    try {
      await writeFreshCache(fixture);

      // When
      const [hi, greet, canonical] = await Promise.all([
        runCli(["help", "hi"], { cwd: fixture.root, env: fixture.env }),
        runCli(["help", "greet"], { cwd: fixture.root, env: fixture.env }),
        runCli(["help", "app:greet"], { cwd: fixture.root, env: fixture.env }),
      ]);

      // Then
      for (const result of [hi, greet, canonical]) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("UnknownCommandError");
        expect(result.stdout).toContain("Echo hello");
        expect(result.stdout).toContain("USAGE");
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
