import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { renderConfigLintResult } from "@lando/core/cli/operations";
import { composeServiceDispositions } from "@lando/sdk/landofile";
import { ConfigLintResult, formatValidationIssuePath } from "@lando/sdk/schema";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const deployReplicasRemediation = composeServiceDispositions["deploy.replicas"]?.remediation;
if (deployReplicasRemediation === undefined) {
  throw new Error("deploy.replicas must declare Compose rejection remediation");
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const parseEnvelopeResult = <A>(stdout: string): A => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as A;
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-config-lint-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
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

describe("renderConfigLintResult", () => {
  const restoreExitCode = <T>(run: () => T): T => {
    const previous = process.exitCode;
    try {
      return run();
    } finally {
      process.exitCode = previous ?? 0;
    }
  };

  test("a valid result renders cleanly and does not flip the exit code", () => {
    const result: ConfigLintResult = { app: "ok", file: "/x/.lando.yml", valid: true, violations: [] };
    restoreExitCode(() => {
      const before = process.exitCode;
      const text = renderConfigLintResult(result, "text");
      expect(text).toContain("no config lint findings");
      expect(process.exitCode).toBe(before);
    });
  });

  test("an invalid result renders violations without changing process.exitCode", () => {
    const result: ConfigLintResult = {
      app: "bad",
      file: "/x/.lando.yml",
      valid: false,
      violations: [
        {
          rule: "landofile.validation",
          severity: "error",
          path: ["bogus"],
          message: "is unexpected",
          suggestion: "Remove the unsupported key",
        },
      ],
    };
    restoreExitCode(() => {
      process.exitCode = 37;
      const text = renderConfigLintResult(result, "text");
      expect(text).toContain("bogus");
      expect(text).toContain("fix:");
      expect(process.exitCode).toBe(37);
    });
  });

  test("ConfigLintResult schema encodes the structured lint result faithfully", () => {
    const result: ConfigLintResult = {
      app: "bad",
      file: "/x/.lando.yml",
      valid: false,
      violations: [
        { rule: "landofile.validation", severity: "error", path: ["bogus"], message: "is unexpected" },
      ],
    };
    restoreExitCode(() => {
      const encoded = Schema.encodeSync(ConfigLintResult)(result);
      expect(encoded).toEqual(result);
    });
  });
});

describe("lando app:config:lint (source dispatch)", () => {
  test("an unchanged wrong type is one readable machine finding with both scopes", async () => {
    // Given
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: wrong-type\nservices:\n  api:\n    primary: maybe\n");
      // When
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      // Then
      expect(result.exitCode).toBe(1);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(result.stdout));
      expect(envelope.result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.validation",
          path: ["services", "api", "primary"],
          message: "Expected boolean",
          scopes: ["fragment", "effective"],
        }),
      ]);
    });
  });

  test("an overlay typo is one machine record listing both scopes", async () => {
    // Given
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: merged-scopes\n");
      await writeFile(join(dir, ".lando.local.yml"), "services:\n  web:\n    imagee: nginx\n");
      // When
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      // Then
      expect(result.exitCode).toBe(1);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(result.stdout));
      expect(envelope.result.valid).toBe(false);
      expect(envelope.result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.validation",
          path: ["services", "web", "imagee"],
          scopes: ["fragment", "effective"],
          source: {
            file: join(dir, ".lando.local.yml"),
            layer: "local",
            path: ["services", "web", "imagee"],
          },
        }),
      ]);
    });
  });

  test("unknown events return a successful JSON envelope with a lint violation", async () => {
    // Given
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: events\nevents:\n  pre-nope: [echo hi]\n");
      // When
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      // Then
      expect(result.exitCode).toBe(1);
      const envelope = Schema.decodeUnknownSync(
        Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
      )(JSON.parse(result.stdout));
      expect(envelope.result.valid).toBe(false);
      expect(envelope.result.violations).toEqual([
        expect.objectContaining({ rule: "landofile.event", path: ["events", "pre-nope"] }),
      ]);
    });
  });
  test("resolved service and route errors are lint violations rather than a failed envelope", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        'name: resolved-errors\nservices:\n  db:\n    type: postgres:16\n    environment:\n      PGPORT: "5433"\n  web:\n    type: nginx\n    hostnames: [bad_host!]\n    routes:\n      - hostname: "{{ app.name }}_bad.lndo.site"\n      - hostname: ok.lndo.site\n        pathPrefix: no-slash\n',
      );
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      expect(result.exitCode).toBe(1);
      const parsed = parseEnvelopeResult<ConfigLintResult>(result.stdout);
      expect(parsed.valid).toBe(false);
      expect(parsed.violations.map((issue) => issue.path)).toEqual([
        ["services", "db", "environment", "PGPORT"],
        ["services", "web", "routes", 0, "hostname"],
        ["services", "web", "routes", 1, "pathPrefix"],
        ["services", "web", "hostnames", 0],
      ]);
      expect(
        parsed.violations.every(
          (issue) =>
            issue.source !== undefined &&
            "file" in issue.source &&
            issue.source.file === join(dir, ".lando.yml"),
        ),
      ).toBe(true);
    });
  });
  test("warning-only lint renders its stable rule and exits successfully", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        'name: warning\nservices:\n  web:\n    type: node:lts\n    healthcheck: [CMD, "echo ready"]\n',
      );
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("healthcheck.bare-compose-marker");
      expect(result.stdout).toContain("warning");
    });
  });
  test("help --all names the typeable lint command and its canonical id", async () => {
    await withTempCwd(async (dir) => {
      const help = await runCli(["help", "--all"], dir);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toMatch(/^\s+config:lint\s+.*\(app:config:lint\)/mu);
      expect(help.stdout).not.toMatch(/^\s+app:config:lint\s/mu);
    });
  });

  test("a clean Landofile exits 0 with a no-violations message", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: clean-app\nrecipe: lamp\n");
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no config lint findings");
    });
  });

  test("--format=json on a clean Landofile emits a valid ConfigLintResult", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: json-app\nrecipe: lamp\n");
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      const parsed = parseEnvelopeResult<ConfigLintResult>(result.stdout);
      expect(parsed.valid).toBe(true);
      expect(parsed.app).toBe("json-app");
      expect(parsed.violations).toHaveLength(0);
    });
  });

  test("--format=json on a TS-only Landofile emits a valid ConfigLintResult", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        'export default { name: "ts-json-app", services: { web: { image: "node:lts" } } };\n',
      );

      const result = await runCli(["app:config:lint", "--format=json"], dir);

      expect(result.exitCode).toBe(0);
      const parsed = parseEnvelopeResult<ConfigLintResult>(result.stdout);
      expect(parsed.valid).toBe(true);
      expect(parsed.app).toBe("ts-json-app");
      expect(parsed.violations).toHaveLength(0);
    });
  });

  test("a schema violation exits non-zero with a structured violation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: bad-app\nbogusKey: nope\n");
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("bogusKey");
    });
  });

  test.each(["json", "yaml"])(
    "--format=%s reports violations with path, message, and suggested fix",
    async (format) => {
      await withTempCwd(async (dir) => {
        await writeFile(join(dir, ".lando.yml"), "name: bad-app\nbogusKey: nope\n");
        const result = await runCli(["app:config:lint", `--format=${format}`], dir);
        expect(result.exitCode).toBe(1);
        const envelope = Schema.decodeUnknownSync(
          Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
        )(format === "yaml" ? Bun.YAML.parse(result.stdout) : JSON.parse(result.stdout));
        const parsed = envelope.result;
        expect(parsed.valid).toBe(false);
        const violation = parsed.violations.find((entry) =>
          formatValidationIssuePath(entry.path).includes("bogusKey"),
        );
        expect(violation).toBeDefined();
        expect(typeof violation?.message).toBe("string");
        expect(violation?.suggestion).toBeDefined();
      });
    },
  );

  test("--format=json reports rejected Compose top-level keys with targeted remediation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: bad-app\nprofiles: [dev]\n");
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      expect(result.exitCode).toBe(1);
      const parsed = parseEnvelopeResult<ConfigLintResult>(result.stdout);
      expect(parsed.valid).toBe(false);
      const violation = parsed.violations.find(
        (entry) => formatValidationIssuePath(entry.path) === "profiles",
      );
      expect(violation?.suggestion).toContain(
        'The top-level key "profiles" is not a Compose top-level key; profiles is a service-level key',
      );
      expect(violation?.suggestion).toContain("includes:");
    });
  });

  test("--format=json reports a rejected Compose service key with matrix remediation", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: bad-app\nservices:\n  web:\n    deploy:\n      replicas: 3\n",
      );

      const result = await runCli(["app:config:lint", "--format=json"], dir);
      const parsed = parseEnvelopeResult<ConfigLintResult>(result.stdout);
      const violation = parsed.violations.find(
        (entry) => formatValidationIssuePath(entry.path) === "services.web.deploy.replicas",
      );

      expect(result.exitCode).toBe(1);
      expect(parsed.valid).toBe(false);
      expect(violation?.suggestion).toBe(deployReplicasRemediation);
    });
  });

  test("--format=json preserves template render diagnostic locations", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "template: definitely-missing\nname: bad-app\n");
      const result = await runCli(["app:config:lint", "--format=json"], dir);
      expect(result.exitCode).toBe(1);
      const parsed = parseEnvelopeResult<ConfigLintResult>(result.stdout);
      expect(parsed.valid).toBe(false);
      const violation = parsed.violations[0];
      expect(formatValidationIssuePath(violation?.path ?? [])).toBe("");
      expect(violation?.line).toBe(1);
      expect(violation?.column).toBe(1);
    });
  });

  test("a missing Landofile fails with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:config:lint"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(".lando.yml");
    });
  });
});
