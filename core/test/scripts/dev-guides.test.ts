import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  computeAffectedGuides,
  parseDevGuidesArgs,
  pruneOrphanGeneratedGuides,
} from "../../../scripts/dev-guides.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatedRoot = resolve(repoRoot, "test/scenarios/generated/guides");

const guideContent = (guideId: string, run = '<Run command="version" />'): string =>
  [
    "---",
    `id: ${guideId}`,
    "provider: test",
    "---",
    "",
    "<Guide>",
    '  <Scenario id="runs">',
    '    <Step name="run">',
    `      ${run}`,
    "    </Step>",
    "  </Scenario>",
    "</Guide>",
    "",
  ].join("\n");

const writeGuide = async (guideId: string, content: string): Promise<string> => {
  const guidePath = resolve(repoRoot, "docs/guides", `${guideId}.mdx`);
  await mkdir(dirname(guidePath), { recursive: true });
  await Bun.write(guidePath, content);
  return `docs/guides/${guideId}.mdx`;
};

const removeGuide = async (guideId: string): Promise<void> => {
  await rm(resolve(repoRoot, "docs/guides", `${guideId}.mdx`), { force: true });
  await rm(resolve(repoRoot, "docs/guides", guideId), { force: true, recursive: true });
  await rm(resolve(generatedRoot, guideId), { force: true, recursive: true });
};

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runDevGuides = async (args: ReadonlyArray<string>): Promise<SpawnResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "scripts/dev-guides.ts", ...args],
    cwd: repoRoot,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("dev:guides argument parsing", () => {
  test("defaults to watch mode with no single guide", () => {
    const options = parseDevGuidesArgs([]);
    expect(options.once).toBe(false);
    expect(options.singleGuidePath).toBeUndefined();
  });

  test("parses --once", () => {
    expect(parseDevGuidesArgs(["--once"]).once).toBe(true);
  });

  test("parses a single-guide path positional", () => {
    const options = parseDevGuidesArgs(["docs/guides/sample.mdx"]);
    expect(options.singleGuidePath).toBe("docs/guides/sample.mdx");
    expect(options.once).toBe(false);
  });

  test("parses a single-guide path with --once together", () => {
    const options = parseDevGuidesArgs(["--once", "docs/guides/sample.mdx"]);
    expect(options.once).toBe(true);
    expect(options.singleGuidePath).toBe("docs/guides/sample.mdx");
  });

  test("rejects unknown flags", () => {
    expect(() => parseDevGuidesArgs(["--nope"])).toThrow();
  });
});

describe("computeAffectedGuides", () => {
  const ctx = {
    allGuideIds: ["alpha", "beta"],
    guidePathToId: new Map([
      ["docs/guides/alpha.mdx", "alpha"],
      ["docs/guides/nested/beta.mdx", "beta"],
    ]),
  };

  test("an MDX change maps to that guide only", () => {
    expect(computeAffectedGuides("docs/guides/alpha.mdx", ctx)).toEqual(["alpha"]);
    expect(computeAffectedGuides("docs/guides/nested/beta.mdx", ctx)).toEqual(["beta"]);
  });

  test("a production-source change affects every guide", () => {
    expect(computeAffectedGuides("core/src/foo.ts", ctx)).toEqual(["alpha", "beta"]);
    expect(computeAffectedGuides("sdk/src/bar.ts", ctx)).toEqual(["alpha", "beta"]);
    expect(computeAffectedGuides("plugins/service-lando/src/x.ts", ctx)).toEqual(["alpha", "beta"]);
    expect(computeAffectedGuides("scripts/build-guide-scenarios.ts", ctx)).toEqual(["alpha", "beta"]);
  });

  test("single-guide mode pins every change to the one guide", () => {
    const single = { ...ctx, singleGuideId: "alpha" };
    expect(computeAffectedGuides("core/src/foo.ts", single)).toEqual(["alpha"]);
    expect(computeAffectedGuides("docs/guides/nested/beta.mdx", single)).toEqual(["alpha"]);
  });
});

describe("pruneOrphanGeneratedGuides", () => {
  test("removes generated dirs without a matching guide id and keeps valid ones", async () => {
    const orphanId = "dev-guides-orphan-prune";
    const keepId = "dev-guides-keep-prune";
    const orphanDir = resolve(generatedRoot, orphanId);
    const keepDir = resolve(generatedRoot, keepId);
    try {
      await mkdir(orphanDir, { recursive: true });
      await mkdir(keepDir, { recursive: true });
      await Bun.write(resolve(orphanDir, "stale.test.ts"), "// stale\n");
      await Bun.write(resolve(keepDir, "live.test.ts"), "// live\n");

      await pruneOrphanGeneratedGuides(new Set([keepId]));

      expect(await Bun.file(resolve(orphanDir, "stale.test.ts")).exists()).toBe(false);
      expect(await Bun.file(resolve(keepDir, "live.test.ts")).exists()).toBe(true);
    } finally {
      await rm(orphanDir, { force: true, recursive: true });
      await rm(keepDir, { force: true, recursive: true });
    }
  });
});

describe.serial("dev:guides one-shot pipeline", () => {
  test("runs a green guide and reports a pass", async () => {
    const guideId = "dev-guides-green";
    try {
      const path = await writeGuide(guideId, guideContent(guideId));
      const result = await runDevGuides(["--once", path]);

      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("1 pass");
      expect(await Bun.file(resolve(generatedRoot, guideId, "runs.test.ts")).exists()).toBe(true);
    } finally {
      await removeGuide(guideId);
    }
  }, 60000);

  test("surfaces a source-mapped failure for a red guide", async () => {
    const guideId = "dev-guides-red";
    try {
      const path = await writeGuide(
        guideId,
        guideContent(guideId, '<Run command="version" expectExit={1} />'),
      );
      const result = await runDevGuides(["--once", path]);
      const combined = `${result.stdout}${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(combined).toContain(`at docs/guides/${guideId}.mdx:`);
      expect(combined).toContain(`[${guideId}:runs]`);
    } finally {
      await removeGuide(guideId);
    }
  }, 60000);

  test("fails when a requested guide emits no scenarios", async () => {
    const guideId = "dev-guides-empty";
    try {
      const path = await writeGuide(
        guideId,
        ["---", `id: ${guideId}`, "provider: test", "---", "", "<Guide />", ""].join("\n"),
      );
      const result = await runDevGuides(["--once", path]);
      const combined = `${result.stdout}${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(combined).toContain("no generated scenario output");
      expect(await Bun.file(resolve(generatedRoot, guideId, "runs.test.ts")).exists()).toBe(false);
    } finally {
      await removeGuide(guideId);
    }
  }, 60000);

  test("single-guide path isolates the loop to one guide", async () => {
    const targetId = "dev-guides-only-target";
    const otherId = "dev-guides-only-other";
    try {
      const targetPath = await writeGuide(targetId, guideContent(targetId));
      await writeGuide(otherId, guideContent(otherId));
      await rm(resolve(generatedRoot, otherId), { force: true, recursive: true });

      const result = await runDevGuides(["--once", targetPath]);

      expect(result.exitCode).toBe(0);
      expect(await Bun.file(resolve(generatedRoot, targetId, "runs.test.ts")).exists()).toBe(true);
      // The non-target guide must not be generated or executed by single-guide mode.
      expect(await Bun.file(resolve(generatedRoot, otherId, "runs.test.ts")).exists()).toBe(false);
      expect(`${result.stdout}${result.stderr}`).toContain("1 pass");
    } finally {
      await removeGuide(targetId);
      await removeGuide(otherId);
    }
  }, 60000);

  test("exits cleanly on SIGINT during the initial pass", async () => {
    const guideId = "dev-guides-sigint-early";
    try {
      const path = await writeGuide(guideId, guideContent(guideId));
      const proc = Bun.spawn({
        cmd: [process.execPath, "run", "scripts/dev-guides.ts", path],
        cwd: repoRoot,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Signal before the initial generate/typecheck/test pass can finish.
      await Bun.sleep(250);
      proc.kill("SIGINT");
      const exitCode = await proc.exited;
      // 0 = graceful resolve; 130 = standard SIGINT termination. Either proves the
      // process terminated promptly (no hang) once a handler exists from the start.
      expect([0, 130]).toContain(exitCode);
    } finally {
      await removeGuide(guideId);
    }
  }, 60000);

  test("exits cleanly on SIGINT after the initial pass", async () => {
    const guideId = "dev-guides-sigint";
    try {
      const path = await writeGuide(guideId, guideContent(guideId));
      const proc = Bun.spawn({
        cmd: [process.execPath, "run", "scripts/dev-guides.ts", path],
        cwd: repoRoot,
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });

      const decoder = new TextDecoder();
      let stderr = "";
      let sawBanner = false;
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderr += decoder.decode(chunk);
        if (/watching for changes/i.test(stderr)) {
          sawBanner = true;
          proc.kill("SIGINT");
          break;
        }
      }

      const exitCode = await proc.exited;
      expect(sawBanner).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      await removeGuide(guideId);
    }
  }, 60000);
});
