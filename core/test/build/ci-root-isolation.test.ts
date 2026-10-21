import { expect, test } from "bun:test";

import { renderCiWorkflow } from "../../../scripts/build-ci-workflow.ts";
import { renderNightlyWorkflow } from "../../../scripts/build-nightly-workflow.ts";
import { renderProviderMatrixWorkflow } from "../../../scripts/build-provider-matrix-workflow.ts";

const rootKeys = [
  "LANDO_USER_CONF_ROOT",
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

test.each([
  {
    workflow: renderCiWorkflow,
    job: "provider-integration-linux-x64-runner",
    before: "Prepare provider via lando setup",
  },
  {
    workflow: renderCiWorkflow,
    job: "provider-integration-windows-x64",
    before: "Download current-commit Windows runtime bundle",
  },
  {
    workflow: renderCiWorkflow,
    job: "guide-scenarios-linux-x64-runner",
    before: "Run generated guide scenarios",
  },
  { workflow: renderCiWorkflow, job: "container-helper", before: "Set up Lando with Docker" },
  {
    workflow: renderNightlyWorkflow,
    job: "provider-lando-e2e-linux-x64",
    before: "Install Podman 6 toolchain",
  },
  {
    workflow: renderNightlyWorkflow,
    job: "published-manifest-setup-linux-x64",
    before: "Prepare provider via lando setup",
  },
  {
    workflow: renderNightlyWorkflow,
    job: "mysql-arm-client-linux-arm64",
    before: "Assemble current-commit linux-arm64 runtime bundle",
  },
  {
    workflow: renderNightlyWorkflow,
    job: "file-sync-contract-linux-x64",
    before: "Run file-sync contract matrix",
  },
  {
    workflow: renderProviderMatrixWorkflow,
    job: "provider-contracts",
    before: "Prepare managed Lando provider",
  },
])("$job establishes four inherited roots before $before", ({ workflow, job, before }) => {
  const block = workflow()
    .split(/\n(?= {2}[\w-]+:)/)
    .find((entry) => entry.startsWith(`  ${job}:`));
  if (block === undefined) throw new Error(`Missing job: ${job}`);
  const consumer = block.indexOf(before);
  expect(consumer).toBeGreaterThan(0);
  for (const key of rootKeys) {
    const assignment = block.indexOf(`echo "${key}=$RUNNER_TEMP/`);
    expect(assignment).toBeGreaterThan(0);
    expect(assignment).toBeLessThan(consumer);
    expect(block).toMatch(new RegExp(`echo "${key}=.*" >> "\\$GITHUB_ENV"`));
    expect(block).not.toMatch(new RegExp(`^ +${key}:`, "m"));
  }
  expect(block).not.toContain("$HOME/.local/share/lando");
  expect(block).not.toContain("$HOME/.cache/lando");
});
