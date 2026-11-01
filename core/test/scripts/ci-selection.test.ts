import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { renderCiWorkflow } from "../../../scripts/build-ci-workflow.ts";
import { CI_PLATFORMS } from "../../../scripts/ci-platforms.ts";
import { CI_JOB_TIERS, jobSelected, resultFailures, selectPaths } from "../../../scripts/ci-selection.ts";
import { CiGitError, selectCi } from "../../../scripts/select-ci.ts";

describe("CI selection", () => {
  test.each([
    ["docs/page.md", "docs"],
    ["docs/page.mdx", "docs"],
    ["docs/public/favicon.svg", "docs"],
    ["docs/src/assets/logo.svg", "docs"],
    ["docs/guides/start.mdx", "guides"],
    ["docs/guides/start/fixtures/input.json", "guides"],
    ["recipes/drupal/README.mdx", "runtime"],
    ["docs/astro.config.ts", "runtime"],
    ["scripts/build-ci-workflow.ts", "providers"],
    ["scripts/test-ownership.ts", "providers"],
    ["plugins/service-lando/src/php-baseline.ts", "providers"],
    ["plugins/service-lando/test/php-baseline.integration.test.ts", "providers"],
    ["plugins/provider-lando/src/provider.ts", "providers"],
    ["bun.lock", "runtime"],
    ["docs/.bun-version", "runtime"],
    [".bun-version.bak", "runtime"],
    ["core/test/foo.test.ts", "runtime"],
    ["unknown", "runtime"],
  ])("classifies %s as %s", (path, profile) => {
    expect(selectPaths([path])).toMatchObject({ profile, broad: false });
  });

  test.each([
    { paths: [".bun-version"] },
    { paths: [".bun-version", "core/src/cli/run.ts"] },
    { paths: ["core/src/cli/run.ts", ".bun-version"] },
    { paths: [".bun-version", "docs/page.md"] },
    { paths: ["docs/page.md", ".bun-version"] },
    { paths: [".bun-version", "plugins/provider-lando/src/provider.ts"] },
    { paths: ["plugins/provider-lando/src/provider.ts", ".bun-version"] },
  ])("selects broad runtime CI for root Bun toolchain changes %j", ({ paths }) => {
    expect(selectPaths(paths)).toEqual({ profile: "runtime", broad: true, reason: "Bun toolchain change" });
  });

  test("selects every existing platform tier for a Bun toolchain change", () => {
    const selection = selectPaths([".bun-version"]);
    for (const { id } of CI_PLATFORMS) {
      for (const job of [`build-${id}`, `guide-scenarios-${id}`, `provider-integration-${id}`]) {
        const tier = CI_JOB_TIERS[job];
        expect(tier).toBeDefined();
        expect(tier && jobSelected(tier, selection)).toBe(true);
      }
    }
    expect(Object.values(CI_JOB_TIERS).every((tier) => jobSelected(tier, selection))).toBe(true);
  });

  test.each(["failure", "cancelled", "skipped"])("fails closed on broad selected job result %s", (result) => {
    const selection = selectPaths([".bun-version"]);
    for (const id of Object.keys(CI_JOB_TIERS)) {
      expect(resultFailures(selection, { [id]: { result } })).toEqual([`${id}: ${result}`]);
    }
  });

  test("widens mixed changes and empty diffs conservatively", () => {
    expect(selectPaths(["docs/guides/start.mdx", "docs/intro.md"]).profile).toBe("guides");
    expect(selectPaths(["docs/intro.md", "scripts/tool.ts"]).profile).toBe("runtime");
    expect(selectPaths([])).toMatchObject({ profile: "runtime", reason: "empty diff" });
  });

  test("keeps the complete guide binary closure selected without broad provider coverage", () => {
    const selection = selectPaths(["docs/guides/start.mdx"]);
    for (const id of [
      "schema-snapshot",
      "bundled-codegen",
      "library-api-tests",
      "recipe-tests",
      "container-helper",
      "build-linux-x64",
      "runtime-bundle-linux-x64",
      "guide-scenarios-linux-x64-runner",
      "guide-scenarios-windows-x64",
    ]) {
      const tier = CI_JOB_TIERS[id];
      expect(tier && jobSelected(tier, selection)).toBe(true);
    }
    expect(jobSelected("broad", selection)).toBe(false);
    expect(jobSelected("runtime", selection)).toBe(false);
  });

  test.each(["docs/guides/start.mdx", "docs/guides/start/fixtures/input.json"])(
    "requires Windows guide execution for %s",
    (path) => {
      const selection = selectPaths([path]);
      const tier = CI_JOB_TIERS["guide-scenarios-windows-x64"];
      expect(tier && jobSelected(tier, selection)).toBe(true);
      expect(resultFailures(selection, { "guide-scenarios-windows-x64": { result: "skipped" } })).toEqual([
        "guide-scenarios-windows-x64: skipped",
      ]);
      expect(
        resultFailures(selectPaths(["docs/intro.md"]), {
          "guide-scenarios-windows-x64": { result: "skipped" },
        }),
      ).toEqual([]);
    },
  );

  test.each(["failure", "cancelled", "skipped"])("rejects selected %s results", (result) => {
    expect(resultFailures(selectPaths(["docs/intro.md"]), { "docs-build": { result } })).toEqual([
      `docs-build: ${result}`,
    ]);
  });

  test.each(["failure", "cancelled", "skipped"])(
    "requires native Darwin signal %s to fail selected CI",
    (result) => {
      for (const path of ["core/src/cli/process-signals.ts", "plugins/provider-lando/src/index.ts"]) {
        expect(
          resultFailures(selectPaths([path]), {
            "process-signal-tests-darwin": { result },
          }),
        ).toEqual([`process-signal-tests-darwin: ${result}`]);
      }
      expect(
        resultFailures(selectPaths(["docs/guides/start.mdx"]), {
          "process-signal-tests-darwin": { result: "skipped" },
        }),
      ).toEqual([]);
    },
  );

  test("allows only policy-excluded skips and never hides failures or unknown jobs", () => {
    const selection = selectPaths(["docs/intro.md"]);
    expect(resultFailures(selection, { "build-linux-x64": { result: "skipped" } })).toEqual([]);
    expect(resultFailures(selection, { "build-linux-x64": { result: "failure" } })).toHaveLength(1);
    expect(resultFailures(selection, { selection: { result: "cancelled" } })).toHaveLength(1);
    expect(resultFailures(selection, { surprise: { result: "success" } })).toHaveLength(1);
  });

  test("requires affected Linux provider jobs and Windows runtime scenarios to execute", () => {
    const providerSelection = selectPaths(["plugins/service-lando/test/php-baseline.integration.test.ts"]);
    for (const id of ["provider-integration-linux-x64-runner", "provider-integration-linux-x64"]) {
      const tier = CI_JOB_TIERS[id];
      expect(tier && jobSelected(tier, providerSelection)).toBe(true);
      expect(resultFailures(providerSelection, { [id]: { result: "skipped" } })).toEqual([`${id}: skipped`]);
    }
    const runtimeSelection = selectPaths(["landofile/src/include-fragment.ts"]);
    expect(
      resultFailures(runtimeSelection, { "guide-scenarios-windows-x64": { result: "skipped" } }),
    ).toEqual(["guide-scenarios-windows-x64: skipped"]);
    expect(jobSelected("broad", providerSelection)).toBe(false);
  });

  test("forces all jobs on push and dispatch even without history", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const selection = selectCi({ event, base: "", head: "", cwd: "/unusable" });
      expect(selection.broad).toBe(true);
      expect(Object.values(CI_JOB_TIERS).every((tier) => jobSelected(tier, selection))).toBe(true);
    }
  });

  test("falls back for unusable SHAs without executing a diff", () => {
    expect(selectCi({ event: "pull_request", base: "--bad", head: "", cwd: "/unusable" })).toMatchObject({
      profile: "providers",
      broad: false,
    });
  });

  test("does not mistake a broken git execution for unavailable history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ci-selection-broken-"));
    try {
      expect(() =>
        selectCi({ event: "pull_request", base: "a".repeat(40), head: "b".repeat(40), cwd }),
      ).toThrow(CiGitError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses merge-base history and classifies both sides of renames with NUL-safe names", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ci-selection-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        ["git", "-c", "user.name=CI test", "-c", "user.email=ci@example.test", ...args],
        { cwd },
      );
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      git("init");
      await mkdir(join(cwd, "docs"));
      await writeFile(join(cwd, "runtime.ts"), "runtime");
      git("add", ".");
      git("commit", "-m", "base");
      const ancestor = git("rev-parse", "HEAD");
      git("checkout", "-b", "base");
      await writeFile(join(cwd, "base-only.ts"), "base");
      git("add", ".");
      git("commit", "-m", "base advances");
      const base = git("rev-parse", "HEAD");
      git("checkout", "-b", "head", ancestor);
      await mkdir(join(cwd, "docs"), { recursive: true });
      const filename = process.platform === "win32" ? "new page.md" : "new\npage.md";
      await writeFile(join(cwd, "docs", filename), "docs");
      git("add", ".");
      git("commit", "-m", "docs");
      expect(selectCi({ event: "pull_request", base, head: git("rev-parse", "HEAD"), cwd }).profile).toBe(
        "docs",
      );
      git("mv", "runtime.ts", "docs/moved.md");
      git("commit", "-m", "move runtime to docs");
      expect(selectCi({ event: "pull_request", base, head: git("rev-parse", "HEAD"), cwd }).profile).toBe(
        "runtime",
      );
      expect(selectCi({ event: "pull_request", base: "f".repeat(40), head: ancestor, cwd }).reason).toBe(
        "missing commit history",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not broaden a PR for a Bun toolchain change made only on its base branch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ci-selection-base-bun-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(
        ["git", "-c", "user.name=CI test", "-c", "user.email=ci@example.test", ...args],
        { cwd },
      );
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      git("init");
      await writeFile(join(cwd, ".bun-version"), "1.4.2\n");
      git("add", ".");
      git("commit", "-m", "common ancestor");
      const ancestor = git("rev-parse", "HEAD");
      git("checkout", "-b", "base");
      await writeFile(join(cwd, ".bun-version"), "1.4.3\n");
      git("add", ".");
      git("commit", "-m", "base changes Bun");
      const base = git("rev-parse", "HEAD");
      git("checkout", "-b", "head", ancestor);
      await mkdir(join(cwd, "docs"));
      await writeFile(join(cwd, "docs/page.md"), "docs\n");
      git("add", ".");
      git("commit", "-m", "unrelated PR");
      expect(selectCi({ event: "pull_request", base, head: git("rev-parse", "HEAD"), cwd })).toEqual({
        profile: "docs",
        broad: false,
        reason: "changed paths",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("generates a direct always-running final gate and explicit selection on every required job", () => {
    const workflow = Schema.decodeUnknownSync(
      Schema.Struct({
        jobs: Schema.Record(
          Schema.String,
          Schema.Struct({
            needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
            if: Schema.optional(Schema.String),
          }),
        ),
      }),
    )(Bun.YAML.parse(renderCiWorkflow()));
    expect(workflow.jobs.ci?.if).toBe("always()");
    expect(workflow.jobs.ci?.needs).toEqual([
      "selection",
      ...Object.keys(CI_JOB_TIERS).filter((id) => id !== "bun-install-isolated-experiment"),
    ]);
    for (const id of Object.keys(CI_JOB_TIERS)) {
      expect(workflow.jobs[id]?.needs).toContain("selection");
      expect(workflow.jobs[id]?.if).toContain("always()");
      expect(workflow.jobs[id]?.if).toContain("needs.selection.outputs");
    }
    expect(workflow.jobs["build-linux-x64"]?.if).toContain("!failure()");
  });

  test.each(["docs", "guides", "runtime", "providers", "broad"] as const)(
    "executes the %s graph without cascading policy-intended skips",
    (profile) => {
      const jobs = Schema.decodeUnknownSync(
        Schema.Struct({
          jobs: Schema.Record(Schema.String, Schema.Struct({ if: Schema.optional(Schema.String) })),
        }),
      )(Bun.YAML.parse(renderCiWorkflow())).jobs;
      const docs = ["static-checks-platform", "static-checks", "docs-build"];
      const guides = [
        ...docs,
        "schema-snapshot",
        "bundled-codegen",
        "library-api-tests-runner",
        "library-api-tests",
        "recipe-tests-runner",
        "recipe-tests",
        "container-helper",
        "build-linux-x64",
        "runtime-bundle-linux-x64",
        "guide-scenarios-linux-x64-runner",
        "guide-scenarios-linux-x64",
        "guide-scenarios-windows-x64",
      ];
      const runtime = [
        ...guides,
        "unit-tests-linux-x64-shard",
        "unit-tests-linux-x64",
        "test-isolation-linux-x64",
        "process-signal-tests-darwin",
        "perf-budget-linux-x64",
      ];
      const providers = [
        ...runtime,
        "provider-integration-linux-x64-runner",
        "provider-integration-linux-x64",
      ];
      const expected = { docs, guides, runtime, providers, broad: Object.keys(CI_JOB_TIERS) }[profile];
      const needs = {
        ...Object.fromEntries(
          Object.keys(CI_JOB_TIERS).map((id) => [
            id,
            { result: expected.includes(id) ? "success" : "skipped" },
          ]),
        ),
        selection: {
          result: "success",
          outputs: { profile: profile === "broad" ? "runtime" : profile, broad: String(profile === "broad") },
        },
      };
      for (const id of Object.keys(CI_JOB_TIERS)) {
        const expression = jobs[id]?.if?.replace(/^\$\{\{ | \}\}$/g, "");
        expect(expression).toBeDefined();
        const evaluate = new Function("needs", "always", "cancelled", "failure", `return ${expression}`);
        const actual: unknown = evaluate(
          needs,
          () => true,
          () => false,
          () => false,
        );
        expect({ id, selected: actual }).toEqual({ id, selected: expected.includes(id) });
      }
      expect(
        resultFailures(
          { profile: profile === "broad" ? "runtime" : profile, broad: profile === "broad", reason: "graph" },
          needs,
        ),
      ).toEqual([]);
    },
  );

  test("typechecks docs-only PRs in the Linux static cell instead of repeating it in guide jobs", () => {
    const jobs = Schema.decodeUnknownSync(
      Schema.Struct({
        jobs: Schema.Record(
          Schema.String,
          Schema.Struct({
            steps: Schema.Array(
              Schema.Struct({
                name: Schema.optional(Schema.String),
                run: Schema.optional(Schema.String),
                if: Schema.optional(Schema.String),
              }),
            ),
          }),
        ),
      }),
    )(Bun.YAML.parse(renderCiWorkflow())).jobs;
    expect(jobs["static-checks-platform"]?.steps.find((step) => step.run === "bun run typecheck")).toEqual({
      name: "Typecheck",
      if: "matrix.platform == 'linux-x64'",
      run: "bun run typecheck",
    });
    expect(
      Object.values(jobs)
        .flatMap((job) => job.steps)
        .filter((step) => step.run === "bun run typecheck"),
    ).toHaveLength(1);
  });
});

describe("platform build path selection", () => {
  test.each([
    "core/test/build/host-execution-compiled.test.ts",
    "core/test/build/opentui-compiled-acceptance.test.ts",
    "core/test/build/support/fixture.ts",
    "scripts/codegen.ts",
    "scripts/build-command-registry-manifest.ts",
    "scripts/build-compiled-binary.ts",
    "scripts/sanitize-compiled-binary.ts",
    "scripts/smoke-windows-binary.ts",
    "scripts/check-compiled-binary-notices.ts",
  ])("selects every platform build for %s", (path) => {
    // Given / When: classify a platform job's script or compiled-test input.
    const selection = selectPaths([path]);
    // Then: no platform build can be skipped for this PR.
    expect(selection).toEqual({ profile: "runtime", broad: true, reason: "platform build path" });
    for (const { id } of CI_PLATFORMS) {
      const tier = CI_JOB_TIERS[`build-${id}`];
      expect(tier).toBeDefined();
      expect(tier && jobSelected(tier, selection)).toBe(true);
      expect(resultFailures(selection, { [`build-${id}`]: { result: "skipped" } })).toEqual([
        `build-${id}: skipped`,
      ]);
    }
  });

  test.each([
    ["docs/page.md", "docs"],
    ["plugins/provider-lando/src/provider.ts", "providers"],
  ])("keeps %s non-broad", (path, profile) => {
    expect(selectPaths([path])).toMatchObject({ profile, broad: false });
  });

  test("platform build selection precedes provider selection in a mixed diff", () => {
    expect(
      selectPaths(["plugins/provider-lando/src/provider.ts", "core/test/build/fixture.test.ts"]),
    ).toEqual({ profile: "runtime", broad: true, reason: "platform build path" });
  });
});
