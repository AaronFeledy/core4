import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { renderInstallLifecycleWorkflow } from "../../../scripts/build-install-lifecycle-journey-workflow.ts";
import { prepareLifecycleDistribution } from "../../../scripts/install-lifecycle-journey-install.ts";
import {
  type LifecycleActions,
  LifecycleJourneyError,
  assertLifecycleRemoval,
  runLifecycle,
} from "../../../scripts/install-lifecycle-journey-runner.ts";

const actionsFor = (failAt?: keyof LifecycleActions) => {
  const calls: string[] = [];
  const action = (id: keyof LifecycleActions) => async () => {
    calls.push(id);
    if (id === failAt) throw new LifecycleJourneyError(`Failure: ${id}`);
  };
  const actions: LifecycleActions = {
    preflight: action("preflight"),
    install: action("install"),
    setup: action("setup"),
    start: action("start"),
    functional: action("functional"),
    destroy: action("destroy"),
    uninstall: action("uninstall"),
    removal: action("removal"),
  };
  return { calls, actions };
};

describe("install lifecycle behavior", () => {
  test("passes only after app functionality and owned removal succeed", async () => {
    // Given a successful operational and cleanup surface.
    const fixture = actionsFor();
    // When the lifecycle is driven.
    const result = await runLifecycle(fixture.actions);
    // Then every phase is used, with removal after uninstall.
    expect(result.classification).toEqual({ outcome: "passed", exitCode: 0 });
    expect(fixture.calls).toEqual([
      "preflight",
      "install",
      "setup",
      "start",
      "functional",
      "destroy",
      "uninstall",
      "removal",
    ]);
  });

  test.each(["start", "functional"] as const)(
    "destroys a possibly running app after %s fails",
    async (phase) => {
      // Given an operational failure after setup.
      const fixture = actionsFor(phase);
      // When cleanup succeeds.
      const result = await runLifecycle(fixture.actions);
      // Then cleanup cannot erase the original failure.
      expect(result.classification.exitCode).toBe(1);
      expect(result.steps.find((step) => step.id === phase)?.exitCode).toBe(1);
      expect(fixture.calls.slice(-3)).toEqual(["destroy", "uninstall", "removal"]);
    },
  );

  test.each(["install", "setup"] as const)(
    "uninstalls partial installation after %s fails",
    async (phase) => {
      // Given installation or setup may have partially changed owned paths.
      const fixture = actionsFor(phase);
      // When the lifecycle fails early.
      const result = await runLifecycle(fixture.actions);
      // Then no app starts, but uninstall and removal are still attempted.
      expect(result.classification.exitCode).toBe(1);
      expect(fixture.calls).not.toContain("start");
      expect(fixture.calls.slice(-2)).toEqual(["uninstall", "removal"]);
    },
  );

  test.each(["destroy", "uninstall", "removal"] as const)("fails when %s cleanup fails", async (phase) => {
    // Given functional operation but a cleanup failure.
    const fixture = actionsFor(phase);
    // When cleanup is driven.
    const result = await runLifecycle(fixture.actions);
    // Then later cleanup still runs and the journey fails.
    expect(result.classification.exitCode).toBe(1);
    expect(fixture.calls.slice(-3)).toEqual(["destroy", "uninstall", "removal"]);
  });

  test("does not install or delete anything after a rejected preflight", async () => {
    // Given a runner with an existing managed machine.
    const fixture = actionsFor("preflight");
    // When preflight rejects it.
    const result = await runLifecycle(fixture.actions);
    // Then no ownership is assumed and rejection is not a skip/pass.
    expect(fixture.calls).toEqual(["preflight"]);
    expect(result.classification.exitCode).toBe(1);
  });

  test("fails removal evidence when an owned path remains", async () => {
    // Given a leftover executable.
    const root = await mkdtemp(join(tmpdir(), "lifecycle-leftover-"));
    const binary = join(root, "lando");
    await writeFile(binary, "leftover");
    try {
      // When the uninstall postcondition is inspected.
      const result = assertLifecycleRemoval([binary], 0);
      // Then the leftover is a failure, not a successful cleanup.
      await expect(result).rejects.toThrow(LifecycleJourneyError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("verifies actual fixture payload bytes through the real platform installer", async () => {
    // Given a distribution fixture with genuine SHA256 and test-only signature trust.
    const root = await mkdtemp(join(tmpdir(), "lifecycle-install-"));
    const source = join(root, "payload");
    const work = join(root, "work");
    await mkdir(work);
    await writeFile(source, "unit-test payload, never executed");
    try {
      const distribution = await prepareLifecycleDistribution(source, work);
      const destination = join(root, "bin");
      const run = async () => {
        const proc = Bun.spawn({
          cmd: distribution.argv,
          env: {
            ...process.env,
            ...distribution.env,
            HOME: root,
            LANDO_USER_DATA_ROOT: join(root, "data"),
            LANDO_INSTALL_DIR: destination,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text(),
          new Response(proc.stdout).text(),
        ]);
        return { exitCode, stderr };
      };
      // When the real installer checks and publishes the payload.
      const result = await run();
      // Then ownership was produced by the installer and content was preserved.
      expect(result).toEqual({ exitCode: 0, stderr: "" });
      expect(
        await readFile(join(destination, process.platform === "win32" ? "lando.exe" : "lando"), "utf8"),
      ).toBe("unit-test payload, never executed");
      expect(await Bun.file(join(root, "data", "install", "record.json")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects corrupted payload even with fixture signature verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-checksum-"));
    const source = join(root, "payload");
    const work = join(root, "work");
    await mkdir(work);
    await writeFile(source, "original bytes");
    try {
      const distribution = await prepareLifecycleDistribution(source, work);
      const artifact = process.platform === "win32" ? "lando-windows-x64.exe" : "lando-linux-x64";
      await writeFile(join(work, "distribution-fixture", artifact), "tampered bytes");
      const proc = Bun.spawn({
        cmd: distribution.argv,
        env: {
          ...process.env,
          ...distribution.env,
          HOME: root,
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_INSTALL_DIR: join(root, "bin"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Checksum mismatch");
      expect(
        await Bun.file(join(root, "bin", process.platform === "win32" ? "lando.exe" : "lando")).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const Workflow = Schema.Struct({
  on: Schema.Record(Schema.String, Schema.Unknown),
  permissions: Schema.Record(Schema.String, Schema.String),
  concurrency: Schema.Struct({ group: Schema.String, "cancel-in-progress": Schema.Boolean }),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.String,
      "runs-on": Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      steps: Schema.Array(
        Schema.Struct({
          run: Schema.optionalKey(Schema.String),
          uses: Schema.optionalKey(Schema.String),
          if: Schema.optionalKey(Schema.String),
          with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  ),
});

describe("trusted install lifecycle evidence workflow", () => {
  test("never admits PR or non-main dispatch code to any runner", () => {
    // Given the emitted workflow contract.
    const workflow = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(renderInstallLifecycleWorkflow()));
    // When each job's trust condition is evaluated for event/ref combinations.
    for (const job of Object.values(workflow.jobs)) {
      const allowed = new Function("github", `return (${job.if});`);
      // Then only trusted main schedule and manual invocations are admitted.
      for (const event of ["pull_request", "pull_request_target", "push", "schedule", "workflow_dispatch"]) {
        for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/pull/7/merge"]) {
          expect(allowed({ ref, event_name: event })).toBe(
            ref === "refs/heads/main" && ["schedule", "workflow_dispatch"].includes(event),
          );
        }
      }
    }
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("runs precisely Ubuntu24.04 and existing Windows virtualization cells with required evidence", async () => {
    // Given the generated workflow.
    const rendered = renderInstallLifecycleWorkflow();
    const workflow = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(rendered));
    // When lifecycle jobs are selected.
    const jobs = Object.entries(workflow.jobs).filter(([name]) => name.startsWith("install-lifecycle-"));
    // Then both cells drive the real script and require evidence even on failure.
    expect(jobs.map(([name, job]) => [name, job["runs-on"]])).toEqual([
      ["install-lifecycle-linux-x64", "ubuntu-24.04"],
      ["install-lifecycle-windows-x64", ["self-hosted", "lando-virt", "Windows", "X64"]],
    ]);
    for (const [, job] of jobs) {
      expect(
        job.steps.some((step) => step.run?.includes("scripts/install-lifecycle-journey.ts --binary")),
      ).toBe(true);
      expect(job.steps.find((step) => step.uses === "actions/upload-artifact@v6")).toMatchObject({
        if: "always()",
        with: { "if-no-files-found": "error" },
      });
      expect(job.steps.some((step) => step.run?.includes("poweroff"))).toBe(false);
    }
    expect(
      await Bun.file(resolve(import.meta.dirname, "../../../.github/workflows/install-lifecycle.yml")).text(),
    ).toBe(rendered);
  });
});
