import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";

for (const debug of [false, true])
  test(`a pre-runtime routing defect exits 1 with a tagged envelope (debug=${debug})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-routing-defect-"));
    const script = join(root, "route.ts");
    const runPath = resolve(import.meta.dir, "../../src/cli/run.ts");
    await writeFile(
      script,
      `import { runCli } from ${JSON.stringify(runPath)};
await runCli({ argv: ["custom-tool", "--format=json", ...${JSON.stringify(debug ? ["--debug"] : [])}], rootUrl: import.meta.url,
  discovery: { cwd: process.cwd(), resolver: { resolve: async () => { throw new Error("routing-private-token\\n    at embedded-stack"); } } } });`,
    );
    try {
      const child = Bun.spawn([process.execPath, script], {
        cwd: root,
        env: {
          ...process.env,
          API_TOKEN: "routing-private-token",
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      if (debug) {
        expect(JSON.parse(stderr)).toMatchObject({ message: "Command defect" });
        expect(stderr).toContain("[redacted]");
        expect(stderr).not.toContain("routing-private-token");
        expect(stderr).not.toMatch(/\n\s+at /u);
      } else expect(stderr).toBe("");
      expect(stdout).not.toContain("routing-private-token");
      expect(stdout).not.toMatch(/\n\s+at /u);
      expect(stdout).not.toContain("embedded-stack");
      expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdout))).toMatchObject({
        ok: false,
        error: { _tag: "LandoInternalError" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
