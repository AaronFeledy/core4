import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import {
  canonicalIdFromRelativePath,
  discoverBunShellScripts,
} from "../../src/landofile/bun-sh-discovery.ts";

const withAppRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-bun-sh-discovery-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeScript = async (appRoot: string, relativePath: string, contents: string): Promise<string> => {
  const target = join(appRoot, ".lando", "scripts", relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
  return target;
};

const expectFailureTag = async <T, E>(
  effect: Effect.Effect<T, E>,
): Promise<{ _tag: string; [k: string]: unknown }> => {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("expected effect to fail");
  const option = Cause.failureOption(exit.cause);
  if (option._tag !== "Some") throw new Error("expected tagged failure");
  return option.value as { _tag: string; [k: string]: unknown };
};

describe("canonicalIdFromRelativePath", () => {
  test("converts a flat .bun.sh relative path into app:<name>", () => {
    expect(canonicalIdFromRelativePath("build.bun.sh")).toEqual({ name: "build", id: "app:build" });
  });

  test("converts nested paths into colon-separated canonical ids", () => {
    expect(canonicalIdFromRelativePath("db/wait.bun.sh")).toEqual({
      name: "db:wait",
      id: "app:db:wait",
    });
    expect(canonicalIdFromRelativePath("ops/cache/clear.bun.sh")).toEqual({
      name: "ops:cache:clear",
      id: "app:ops:cache:clear",
    });
  });

  test("lower-cases mixed-case segments", () => {
    expect(canonicalIdFromRelativePath("DB/Wait.bun.sh")).toEqual({
      name: "db:wait",
      id: "app:db:wait",
    });
  });

  test("returns null for paths without the .bun.sh extension", () => {
    expect(canonicalIdFromRelativePath("build.sh")).toBeNull();
    expect(canonicalIdFromRelativePath("README")).toBeNull();
  });
});

describe("discoverBunShellScripts", () => {
  test("returns an empty list when .lando/scripts is absent", async () => {
    await withAppRoot(async (root) => {
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts).toEqual([]);
    });
  });

  test("returns an empty list when .lando/scripts has no .bun.sh files", async () => {
    await withAppRoot(async (root) => {
      await mkdir(join(root, ".lando", "scripts"), { recursive: true });
      await writeFile(join(root, ".lando", "scripts", "README.md"), "Just docs.\n");
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts).toEqual([]);
    });
  });

  test("parses a top-level script with full front-matter", async () => {
    await withAppRoot(async (root) => {
      const path = await writeScript(
        root,
        "build.bun.sh",
        [
          "#!/usr/bin/env bun",
          "# ---",
          "# desc: Build the app for production",
          "# service: :host",
          "# ---",
          "await Bun.write(Bun.stdout, 'building');",
          "",
        ].join("\n"),
      );
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts).toHaveLength(1);
      const [script] = scripts;
      expect(script).toBeDefined();
      if (script === undefined) return;
      expect(script.id).toBe("app:build");
      expect(script.name).toBe("build");
      expect(script.path).toBe(path);
      expect(script.relativePath).toBe("build.bun.sh");
      expect(script.service).toBe(":host");
      expect(script.summary).toBe("Build the app for production");
    });
  });

  test("derives canonical ids from nested directories", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        join("db", "wait.bun.sh"),
        ["# ---", "# desc: Wait for DB", "# ---", "console.log('ok');", ""].join("\n"),
      );
      await writeScript(
        root,
        join("ops", "cache", "clear.bun.sh"),
        ["# ---", "# summary: Clear caches", "# ---", "console.log('cleared');", ""].join("\n"),
      );
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      const ids = scripts.map((s) => s.id);
      expect(ids).toEqual(["app:db:wait", "app:ops:cache:clear"]);
      expect(scripts[0]?.summary).toBe("Wait for DB");
      expect(scripts[1]?.summary).toBe("Clear caches");
    });
  });

  test("defaults service to :host when the front-matter omits it", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "noop.bun.sh",
        ["# ---", "# desc: A no-op", "# ---", "console.log('noop');", ""].join("\n"),
      );
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.service).toBe(":host");
    });
  });

  test("preserves an explicit service value in the front-matter", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "compose.bun.sh",
        [
          "#!/usr/bin/env bun",
          "# ---",
          "# desc: Run composer",
          "# service: appserver",
          "# ---",
          "console.log('composer');",
          "",
        ].join("\n"),
      );
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.service).toBe("appserver");
    });
  });

  test("accepts an empty front-matter block", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "bare.bun.sh",
        ["#!/usr/bin/env bun", "# ---", "# ---", "console.log('bare');", ""].join("\n"),
      );
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.id).toBe("app:bare");
      expect(scripts[0]?.summary).toBe("");
      expect(scripts[0]?.service).toBe(":host");
    });
  });

  test("rejects empty .bun.sh files with BunShellScriptEmptyError", async () => {
    await withAppRoot(async (root) => {
      await writeScript(root, "empty.bun.sh", "");
      const failure = await expectFailureTag(discoverBunShellScripts({ appRoot: root }));
      expect(failure._tag).toBe("BunShellScriptEmptyError");
      expect(failure.path).toContain("empty.bun.sh");
    });
  });

  test("rejects missing front-matter with BunShellScriptFrontMatterError", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "no-front-matter.bun.sh",
        ["#!/usr/bin/env bun", "console.log('hi');", ""].join("\n"),
      );
      const failure = await expectFailureTag(discoverBunShellScripts({ appRoot: root }));
      expect(failure._tag).toBe("BunShellScriptFrontMatterError");
      expect(failure.path).toContain("no-front-matter.bun.sh");
      expect(failure.message).toContain("missing");
    });
  });

  test("rejects malformed front-matter (unterminated block)", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "broken.bun.sh",
        ["# ---", "# desc: missing closing fence", "console.log('hi');", ""].join("\n"),
      );
      const failure = await expectFailureTag(discoverBunShellScripts({ appRoot: root }));
      expect(failure._tag).toBe("BunShellScriptFrontMatterError");
      expect(failure.message).toContain("malformed");
    });
  });

  test("rejects Beta-only front-matter keys with NotImplementedError", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "beta.bun.sh",
        [
          "# ---",
          "# desc: top-level alias is Beta",
          "# topLevelAlias: build",
          "# ---",
          "console.log('hi');",
          "",
        ].join("\n"),
      );
      const failure = await expectFailureTag(discoverBunShellScripts({ appRoot: root }));
      expect(failure._tag).toBe("NotImplementedError");
      expect(failure.specSection).toBe("§8.5.1");
      expect(failure.commandId).toBe("landofile.parse");
    });
  });

  test("rejects unknown front-matter keys via the strict schema decode", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "typo.bun.sh",
        ["# ---", "# descripshun: typo", "# ---", "console.log('hi');", ""].join("\n"),
      );
      const failure = await expectFailureTag(discoverBunShellScripts({ appRoot: root }));
      expect(failure._tag).toBe("BunShellScriptFrontMatterError");
      expect(failure.message).toContain("malformed");
    });
  });

  test("fails when two scripts resolve to the same canonical id", async () => {
    await withAppRoot(async (root) => {
      await writeScript(
        root,
        "Build.bun.sh",
        ["# ---", "# desc: A", "# ---", "console.log('a');", ""].join("\n"),
      );
      await writeScript(
        root,
        "build.bun.sh",
        ["# ---", "# desc: B", "# ---", "console.log('b');", ""].join("\n"),
      );
      const failure = await expectFailureTag(discoverBunShellScripts({ appRoot: root }));
      expect(failure._tag).toBe("BunShellScriptFrontMatterError");
      expect(failure.message).toContain("same canonical id");
    });
  });

  test("skips dotfiles inside .lando/scripts", async () => {
    await withAppRoot(async (root) => {
      const scriptsDir = join(root, ".lando", "scripts");
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(join(scriptsDir, ".DS_Store"), "");
      await writeScript(
        root,
        "build.bun.sh",
        ["# ---", "# desc: ok", "# ---", "console.log('ok');", ""].join("\n"),
      );
      const scripts = await Effect.runPromise(discoverBunShellScripts({ appRoot: root }));
      expect(scripts.map((s) => s.id)).toEqual(["app:build"]);
    });
  });
});
