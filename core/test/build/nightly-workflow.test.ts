import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { renderNightlyWorkflow } from "../../../scripts/build-nightly-workflow.ts";
import { isShardedUnitTest } from "../../../scripts/test-shards.ts";

const workflowPath = resolve(import.meta.dirname, "../../../.github/workflows/nightly.yml");

type Step = Record<string, unknown>;
type Job = { readonly needs?: ReadonlyArray<string>; readonly steps: ReadonlyArray<Step> };
type Workflow = { readonly jobs: Record<string, Job> };

const firstDerivedConsumer: Readonly<Record<string, readonly [name: string, command: string]>> = {
  "container-helper": ["Set up Lando with Docker", "bun core/bin/lando.ts setup"],
  "file-sync-contract-linux-x64": [
    "Run file-sync contract matrix (linux-x64)",
    "bun test plugins/file-sync-mutagen/test/contract.test.ts",
  ],
  "file-sync-contract-darwin-arm64": [
    "Run file-sync contract matrix (darwin-arm64)",
    "bun test plugins/file-sync-mutagen/test/contract.test.ts",
  ],
  "file-sync-contract-darwin-x64": [
    "Run file-sync contract matrix (darwin-x64)",
    "bun test plugins/file-sync-mutagen/test/contract.test.ts",
  ],
  "file-sync-contract-windows-x64": [
    "Run file-sync contract matrix (windows-x64)",
    "bun test plugins/file-sync-mutagen/test/contract.test.ts",
  ],
  "provider-lando-e2e-linux-x64": ["Build Linux x64 binary", "build:manifest"],
  "service-listeners-linux-x64": ["Compile current listener CLI", "build:manifest"],
  "published-manifest-setup-linux-x64": ["Build Linux x64 binary", "build:manifest"],
  "mysql-arm-client-linux-arm64": ["Build Linux arm64 binary", "build:manifest"],
  "nightly-tier-unit-tests-linux-x64": [
    "Run nightly-tier unit tests",
    "bun test core/test/scripts/codegen-ci.test.ts",
  ],
  "refresh-test-timings-linux-x64": ["Refresh unit-test timings", "bun run scripts/update-test-timings.ts"],
  "distribution-rehearsal-linux-x64": ["Build command registry manifest", "build:manifest"],
};

test("nightly jobs regenerate derived sources after frozen install and before their first consumer", async () => {
  const rendered = renderNightlyWorkflow();
  const committed = await Bun.file(workflowPath).text();
  expect(committed).toBe(rendered);

  for (const source of [rendered, committed]) {
    const { jobs } = Bun.YAML.parse(source) as Workflow;
    expect(Object.keys(jobs).sort()).toEqual(
      [
        ...Object.keys(firstDerivedConsumer),
        "runtime-bundle-manifest-live",
        "runtime-bundle-linux-x64",
      ].sort(),
    );

    for (const [id, [consumerName, consumerCommand]] of Object.entries(firstDerivedConsumer)) {
      const steps = jobs[id]?.steps;
      expect(steps).toBeDefined();
      if (steps === undefined) throw new Error(`Missing nightly job: ${id}`);

      const install = steps.findIndex((step) => step.run === "bun install --frozen-lockfile");
      const codegenSteps = steps.filter((step) => step.run === "bun run codegen");
      const codegen = steps.findIndex((step) => step.run === "bun run codegen");
      const consumer = steps.findIndex(
        (step) =>
          step.name === consumerName && typeof step.run === "string" && step.run.includes(consumerCommand),
      );
      expect(codegenSteps).toHaveLength(1);
      expect(codegenSteps[0]?.name).toBe("Regenerate derived sources");
      expect(codegenSteps[0]).not.toHaveProperty("if");
      expect(codegenSteps[0]).not.toHaveProperty("working-directory");
      expect(codegenSteps[0]).not.toHaveProperty("continue-on-error");
      expect(install).toBeGreaterThanOrEqual(0);
      expect(codegen).toBeGreaterThan(install);
      expect(consumer).toBeGreaterThan(codegen);
    }

    const armSteps = jobs["mysql-arm-client-linux-arm64"]?.steps ?? [];
    const localManifest = armSteps.findIndex(
      (step) =>
        step.name === "Build local runtime bundle manifest" &&
        typeof step.run === "string" &&
        step.run.includes("bun run scripts/build-runtime-bundle.ts --local"),
    );
    expect(localManifest).toBeGreaterThanOrEqual(0);
    expect(localManifest).toBeLessThan(armSteps.findIndex((step) => step.run === "bun run codegen"));

    const pinSteps = jobs["runtime-bundle-manifest-live"]?.steps ?? [];
    expect(pinSteps.filter((step) => step.run === "bun run codegen")).toHaveLength(0);
  }
});

test("nightly workflow regression stays in PR unit-test shards", () => {
  expect(isShardedUnitTest("core/test/build/nightly-workflow.test.ts")).toBe(true);
});

test("nightly managed-runtime jobs provision the binary under test before running suites", () => {
  // Given / When: inspect every rendered job that downloads the managed runtime.
  const { jobs } = Bun.YAML.parse(renderNightlyWorkflow()) as Workflow;
  const socketJobs = Object.entries(jobs).filter(([, job]) =>
    job.steps.some((step) => step.name === "Download current-commit Linux x64 runtime bundle"),
  );
  // Then: the compiled binary and rootless prerequisites precede setup, socket verification, and tests.
  expect(socketJobs.map(([id]) => id).sort()).toEqual([
    "provider-lando-e2e-linux-x64",
    "service-listeners-linux-x64",
  ]);
  for (const [, { steps, needs }] of socketJobs) {
    expect(needs).toContain("runtime-bundle-linux-x64");
    const compile = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.includes("--outfile ./dist/lando"),
    );
    const prereqs = steps.findIndex((step) => step.name === "Provision rootless runtime prerequisites");
    const setup = steps.findIndex(
      (step) => typeof step.run === "string" && step.run.includes("dist/lando setup --yes --provider=lando"),
    );
    const socket = steps.findIndex((step) => step.name === "Verify managed runtime socket");
    const tests = steps.findIndex(
      (step) => typeof step.run === "string" && /bun test |run-guide-scenarios/.test(step.run),
    );
    expect(compile).toBeGreaterThanOrEqual(0);
    expect(prereqs).toBeGreaterThan(compile);
    expect(setup).toBeGreaterThan(prereqs);
    expect(socket).toBeGreaterThan(setup);
    expect(tests).toBeGreaterThan(socket);
    const commands = steps.map((step) => step.run).join("\n");
    expect(commands).toMatch(/LANDO_SCENARIO_E2E_BINARY="?\$GITHUB_WORKSPACE\/dist\/lando"/);
    expect(commands).not.toContain("core/dist/lando");
    expect(commands).not.toContain("brew install podman");
    expect(commands).not.toContain("podman system service");
    expect(steps[prereqs]?.run).toContain("apt-get install -y uidmap fuse-overlayfs");
    expect(steps[prereqs]?.run).toContain("/etc/subuid");
    expect(steps[prereqs]?.run).toContain("/etc/subgid");
    expect(steps[prereqs]?.run).toContain("net.ipv4.ip_unprivileged_port_start=0");
    expect(steps[prereqs]?.run).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(steps[prereqs]?.run).toContain("/sys/fs/cgroup/user.slice");
  }
});

test.each([
  ["nightly-tier-unit-tests-linux-x64", "Run nightly-tier unit tests"],
  ["refresh-test-timings-linux-x64", "Refresh unit-test timings"],
])("%s downloads the current run's container helper before tests", async (id, consumerName) => {
  for (const source of [renderNightlyWorkflow(), await Bun.file(workflowPath).text()]) {
    const { jobs } = Bun.YAML.parse(source) as Workflow;
    const job = jobs[id];
    expect(job?.needs).toContain("container-helper");
    const steps = job?.steps ?? [];
    const download = steps.findIndex((step) => step.name === "Download container helper");
    const restore = steps.findIndex((step) => step.name === "Restore container helper permissions");
    const consumer = steps.findIndex((step) => step.name === consumerName);

    expect(download).toBeGreaterThanOrEqual(0);
    expect(steps[download]).toEqual({
      name: "Download container helper",
      uses: "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
      with: { name: "container-helper", path: "core/container-helper/dist" },
    });
    expect(restore).toBeGreaterThan(download);
    expect(steps[restore]).toEqual({
      name: "Restore container helper permissions",
      shell: "bash",
      run: "chmod +x core/container-helper/dist/linux-*/lando-container-helper",
    });
    expect(consumer).toBeGreaterThan(restore);
  }
});
