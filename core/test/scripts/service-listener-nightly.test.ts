import { expect, test } from "bun:test";
import { Schema } from "effect";
import { serviceListenerNightlyJob } from "../../../scripts/_service-listener-nightly.ts";
import { isShardedUnitTest } from "../../../scripts/test-shards.ts";

const jobSchema = Schema.Struct({
  jobs: Schema.Struct({
    "service-listeners-linux-x64": Schema.Struct({
      needs: Schema.Array(Schema.String),
      "timeout-minutes": Schema.Number,
      env: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(
        Schema.Struct({
          run: Schema.optionalKey(Schema.String),
          uses: Schema.optionalKey(Schema.String),
          shell: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
});

test("supplies strict explicit inputs and bounded container-only image preparation", () => {
  // Given / When: parse the rendered job as the workflow runner does.
  const job = Schema.decodeUnknownSync(jobSchema)(Bun.YAML.parse(`jobs:\n${serviceListenerNightlyJob}`)).jobs[
    "service-listeners-linux-x64"
  ];
  // Then: missing prerequisites cannot silently opt this nightly job out.
  expect(job.env.LANDO_TEST_LISTENERS_STRICT).toBe("1");
  expect(job.env.LANDO_TEST_MINIO_IMAGE).toBe("localhost/lando-listener-minio:qa");
  expect(job.env.LANDO_TEST_MAILPIT_IMAGE).toBeTruthy();
  expect(job.env.LANDO_TEST_LISTENER_CLIENT_IMAGE).toBeTruthy();
  expect(job.needs).toContain("container-helper");
  expect(job.needs).toContain("runtime-bundle-linux-x64");
  expect(job["timeout-minutes"]).toBe(60);
  expect(job.steps.some((step) => step.run?.includes("build-service-listener-qa-image.ts"))).toBe(true);
  // The compiled-binary stamper refuses placeholder 0.0.0 versions.
  expect(job.steps.some((step) => step.run?.includes("--version 0.0.0"))).toBe(false);
  expect(job.steps.some((step) => step.run?.includes('--version "$VERSION"'))).toBe(true);
  expect(job.steps.some((step) => step.uses?.includes("setup-go"))).toBe(false);
});

test("requires successful tests plus four-case evidence instead of accepting an all-skip exit", () => {
  // Given / When: locate the executable acceptance step, not its display label.
  const job = Schema.decodeUnknownSync(jobSchema)(Bun.YAML.parse(`jobs:\n${serviceListenerNightlyJob}`)).jobs[
    "service-listeners-linux-x64"
  ];
  const acceptance = job.steps.find((step) =>
    step.run?.includes("service-listener-journeys.integration.test.ts"),
  );
  // Then: pipefail preserves failures and a separate completion check rejects all-skipped runs.
  expect(acceptance?.shell).toBe("bash");
  expect(acceptance?.run).toContain("set -euo pipefail");
  expect(acceptance?.run).toContain("completed=4/4");
  expect(isShardedUnitTest("plugins/service-lando/test/service-listener-journeys.integration.test.ts")).toBe(
    false,
  );
});

test("provisions rootless user namespaces before managed setup and image preparation", () => {
  // Given / When: decode the job's executable steps.
  const { steps } = Schema.decodeUnknownSync(jobSchema)(Bun.YAML.parse(`jobs:\n${serviceListenerNightlyJob}`))
    .jobs["service-listeners-linux-x64"];
  const prereqs = steps.findIndex((step) =>
    step.run?.includes("kernel.apparmor_restrict_unprivileged_userns=0"),
  );
  const setup = steps.findIndex((step) => step.run?.includes("dist/lando setup --yes --provider=lando"));
  const image = steps.findIndex((step) => step.run?.includes("build-service-listener-qa-image.ts"));
  const journeys = steps.findIndex((step) =>
    step.run?.includes("service-listener-journeys.integration.test.ts"),
  );
  // Then: user namespace permissions are ready before Podman's reexec.
  expect(prereqs).toBeGreaterThanOrEqual(0);
  expect(setup).toBeGreaterThan(prereqs);
  expect(image).toBeGreaterThan(setup);
  expect(journeys).toBeGreaterThan(image);
  expect(steps[prereqs]?.run).toContain("apt-get install -y uidmap fuse-overlayfs");
  const commands = steps.map((step) => step.run).join("\n");
  expect(commands).not.toContain("brew install podman");
  expect(commands).not.toContain("podman system service");
  expect(commands).toContain("LANDO_TEST_PODMAN_SOCKET=$LANDO_USER_DATA_ROOT/runtime/run/podman.sock");
  expect(commands).toContain("LANDO_CONFIG__default_provider_id=lando");
});
