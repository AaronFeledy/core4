import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { renderNightlyWorkflow } from "../../../scripts/build-nightly-workflow.ts";

const workflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    "service-listener-matrix-linux-x64": Schema.Struct({
      needs: Schema.Array(Schema.String),
      "timeout-minutes": Schema.Number,
      env: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(
        Schema.Struct({
          run: Schema.optionalKey(Schema.String),
          shell: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
});
const matrixJob = () =>
  Schema.decodeUnknownSync(workflowSchema)(Bun.YAML.parse(renderNightlyWorkflow())).jobs[
    "service-listener-matrix-linux-x64"
  ];

test("nightly matrix requires strict unfiltered serial execution against the current compiled CLI", () => {
  // Given / When: decode the composed workflow, including the sibling job's actual wiring.
  const job = matrixJob();
  const acceptance = job.steps.find((step) => step.run?.includes("listener-matrix.integration.test.ts"));
  // Then: CI cannot opt out, run concurrently, or use an old binary accidentally.
  expect(job.env.LANDO_TEST_LISTENER_MATRIX_STRICT).toBe("1");
  expect(job.env.LANDO_TEST_LISTENER_MATRIX_MSSQL).toBe("1");
  expect(job.env.LANDO_TEST_MINIO_IMAGE).toBe("localhost/lando-listener-minio:matrix-qa");
  expect(job.env.LANDO_TEST_LISTENER_MATRIX_FAMILIES).toBeUndefined();
  expect(job.needs).toEqual(["container-helper", "runtime-bundle-linux-x64"]);
  expect(job["timeout-minutes"]).toBe(120);
  expect(acceptance?.shell).toBe("bash");
  expect(acceptance?.run).toContain("set -euo pipefail");
  expect(acceptance?.run).toContain("--max-concurrency=1");
  expect(job.steps.map((step) => step.run).join("\n")).toContain(
    "LANDO_SCENARIO_E2E_BINARY=$GITHUB_WORKSPACE/dist/lando",
  );
});

test("nightly matrix prepares isolated roots and managed Podman before image preparation and tests", () => {
  // Given / When: inspect the generated execution order used by GitHub Actions.
  const { steps } = matrixJob();
  const consumers = [
    "LANDO_USER_CONF_ROOT=",
    "bun install --frozen-lockfile",
    "chmod +x core/container-helper/",
    "bun run codegen",
    "--outfile ./dist/lando",
    "kernel.apparmor_restrict_unprivileged_userns=0",
    "dist/lando setup --yes --provider=lando",
    "LANDO_TEST_PODMAN_SOCKET=$LANDO_USER_DATA_ROOT/runtime/run/podman.sock",
    "build-service-listener-qa-image.ts",
    "listener-matrix.integration.test.ts",
  ];
  // Then: no consumer can precede its prerequisite; absent steps also fail the ordering check.
  let previous = -1;
  for (const command of consumers) {
    const index = steps.findIndex((step) => step.run?.includes(command));
    expect(index, command).toBeGreaterThan(previous);
    previous = index;
  }
  const commands = steps.map((step) => step.run).join("\n");
  expect(commands).toContain("apt-get install -y uidmap fuse-overlayfs");
  expect(commands).toContain('--version "$VERSION"');
  expect(commands).not.toContain("podman system service");
  expect(commands).not.toContain("brew install podman");
});

test.each([
  { summary: "SERVICE_LISTENER_MATRIX completed=70/70 cases=apache-default,apache-moved", code: 0 },
  { summary: "SERVICE_LISTENER_MATRIX completed=69/70 cases=apache-default", code: 1 },
  { summary: "SERVICE_LISTENER_MATRIX completed=0/70 cases=", code: 1 },
  { summary: "SERVICE_LISTENER_MATRIX completed=0/0 cases=", code: 1 },
  { summary: "all tests skipped", code: 1 },
])("completion gate returns $code for $summary", async ({ summary, code }) => {
  // Given: the exact completion command from the rendered job and an isolated runner log.
  const acceptance = matrixJob().steps.find((step) =>
    step.run?.includes("listener-matrix.integration.test.ts"),
  );
  const completion = acceptance?.run?.split("\n").find((line) => line.trim().startsWith("grep "));
  if (completion === undefined) throw new Error("Matrix job lacks an executable completion gate");
  const directory = await mkdtemp(join(tmpdir(), "lando-matrix-gate-"));
  try {
    await Bun.write(join(directory, "listener-matrix.log"), `${summary}\n`);
    // When: bash executes the shipped gate, not a duplicate regular expression in the test.
    const child = Bun.spawn(["bash", "-c", completion], {
      env: { ...process.env, RUNNER_TEMP: directory },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [actual, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    // Then: partial, empty and absent completion evidence cannot turn an all-skip run green.
    expect(actual, stderr).toBe(code);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
