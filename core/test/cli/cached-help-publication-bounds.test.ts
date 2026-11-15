import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileToolingCommands } from "@lando/engine/cache/command-compiler";
import {
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "@lando/engine/cache/command-index-writer";
import { rememberLandofileEnvironmentDependencies } from "@lando/landofile/load-expression-provenance";
import { ToolingCompileError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { HelpCatalogResult } from "../../src/cli/compiled-help";

const cli = resolve(import.meta.dirname, "../../bin/lando.ts");
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test.each(["json", "yaml"] as const)(
  "cached help bounds diagnostics after a newly captured secret expands publication in %s",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "lando-help-publication-"));
    try {
      const cacheRoot = join(root, "cache");
      const sourcePath = join(root, ".lando.yml");
      const names = Array.from({ length: 10 }, (_, index) => `${"wxyz-".repeat(160)}${index}`);
      const authored = {
        name: "help-publication",
        tooling: {
          bad: {
            cmd: "echo must-not-run",
            flags: Object.fromEntries(names.map((name) => [name, { alias: "q" }])),
          },
        },
      };
      await writeFile(sourcePath, Bun.YAML.stringify(authored));
      const env = {
        ...process.env,
        LANDO_USER_CACHE_ROOT: cacheRoot,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
      };
      const landofile = rememberLandofileEnvironmentDependencies(
        Schema.decodeUnknownSync(LandofileShape)(authored),
        { _tag: "Names", names: [] },
      );
      await Effect.runPromise(
        writeAppCommandCacheStrict({
          cwd: root,
          cacheRoot,
          env,
          landofile,
          entries: compileToolingCommands(landofile, createRedactor("secrets").redactString, {
            sourcePath,
            toolingSource: () => ({
              path: sourcePath,
              locate: (path) => ({ layer: "canonical", file: sourcePath, path }),
            }),
          }),
        }),
      );
      // The secret is registered only at publication; it is not a recorded environment dependency.
      const publicationEnv = { ...env, HELP_API_TOKEN: "wxyz" };
      const receipt = await Effect.runPromise(
        readAppCommandCacheForCwdDetailed({ cwd: root, cacheRoot, env: publicationEnv }),
      );
      expect(receipt.status).toBe("fresh");
      const child = Bun.spawn([process.execPath, cli, "--help", `--format=${format}`], {
        cwd: root,
        env: publicationEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).not.toContain("wxyz");
      const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: HelpCatalogResult }))(
        format === "json" ? JSON.parse(stdout) : Bun.YAML.parse(stdout),
      );
      expect(envelope.result.toolingMetadata).toEqual({ status: "fresh" });
      for (const rows of [envelope.result.sections.thisApp, envelope.result.all]) {
        const row = rows.find((entry) => entry.canonicalId === "app:bad");
        if (row?.source !== "tooling") throw new Error("Missing tooling help row");
        const diagnostic = Schema.decodeUnknownSync(ToolingCompileError)(row.loadError);
        expect(bytes(diagnostic)).toBeLessThanOrEqual(16 * 1024);
        expect(bytes(diagnostic.message)).toBeLessThanOrEqual(1024);
        expect(bytes(diagnostic.remediation)).toBeLessThanOrEqual(1024);
        expect(diagnostic.issues.length).toBeLessThanOrEqual(8);
        expect(diagnostic.issues.length + diagnostic.omittedIssueCount).toBe(9);
        expect(diagnostic.source).toEqual({ path: sourcePath, task: "bad" });
        for (const issue of diagnostic.issues) {
          expect(issue.source).toEqual({ layer: "canonical", file: sourcePath, path: issue.path });
          expect(names.map((name) => name.replaceAll("wxyz", "[redacted]"))).toContain(String(issue.path[3]));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
