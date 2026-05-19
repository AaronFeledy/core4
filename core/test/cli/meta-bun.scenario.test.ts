import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { metaBun, metaX } from "../../src/cli/commands/bun.ts";

describe("meta:bun command", () => {
  test("invokes the BunSelfRunner with the passed argv", async () => {
    const seen: Array<{ cmd: ReadonlyArray<string>; env: Record<string, string>; cwd: string }> = [];
    const spawner = {
      spawn: async ({
        cmd,
        env,
        cwd,
      }: { cmd: ReadonlyArray<string>; env: Record<string, string>; cwd: string }) => {
        seen.push({ cmd, env, cwd });
        return { exitCode: 0 };
      },
    };
    const result = await Effect.runPromise(
      metaBun({ argv: ["--version"], spawner, execPath: "/usr/local/bin/bun" }),
    );
    expect(result.exitCode).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]?.cmd).toEqual(["/usr/local/bin/bun", "--version"]);
    expect(seen[0]?.env.BUN_BE_BUN).toBe("1");
    expect(seen[0]?.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY).toBe("1");
  });

  test("propagates exit code from spawn", async () => {
    const spawner = { spawn: async () => ({ exitCode: 42 }) };
    const result = await Effect.runPromise(metaBun({ argv: ["test"], spawner, execPath: "/x" }));
    expect(result.exitCode).toBe(42);
  });
});

describe("meta:x command", () => {
  test("prefixes argv with `x <spec>` and prints the running banner", async () => {
    const seen: Array<{ cmd: ReadonlyArray<string> }> = [];
    const spawner = {
      spawn: async ({ cmd }: { cmd: ReadonlyArray<string>; env: Record<string, string>; cwd: string }) => {
        seen.push({ cmd });
        return { exitCode: 0 };
      },
    };
    const banners: string[] = [];
    const result = await Effect.runPromise(
      metaX({
        spec: "prettier",
        argv: ["--write", "."],
        spawner,
        execPath: "/x/bun",
        onBanner: (line) => banners.push(line),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.spec).toBe("prettier");
    expect(seen[0]?.cmd).toEqual(["/x/bun", "x", "prettier", "--write", "."]);
    expect(banners[0]).toBe("Running prettier");
  });
});
