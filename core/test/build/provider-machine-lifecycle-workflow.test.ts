import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const providerMatrixWorkflow = new URL("../../../.github/workflows/provider-matrix.yml", import.meta.url);

const matrixCellBlock = (workflow: string, cellId: string): string => {
  const start = workflow.indexOf(`          - cell: ${cellId}`);
  if (start < 0) return "";
  const next = workflow.indexOf("          - cell:", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
};

test("generated provider matrix wires advisory machine lifecycle cells and opt-ins", async () => {
  const workflow = await readFile(providerMatrixWorkflow, "utf8");

  for (const cellId of [
    "lando-machine-macos",
    "lando-machine-windows",
    "podman-machine-macos",
    "podman-machine-windows",
  ]) {
    const block = matrixCellBlock(workflow, cellId);
    expect(block).toContain(`- cell: ${cellId}`);
    expect(block).toContain("release-blocking: false");
    expect(block).toContain("setup: machine-lifecycle");
  }

  expect(workflow).toContain(
    "LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE: ${{ vars.LANDO_TEST_PROVIDER_LANDO_MACHINE_LIFECYCLE }}",
  );
  expect(workflow).toContain(
    "LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE: ${{ vars.LANDO_TEST_PROVIDER_PODMAN_MACHINE_LIFECYCLE }}",
  );
  expect(workflow).toContain("LANDO_TEST_PODMAN_COMMAND: ${{ vars.LANDO_TEST_PODMAN_COMMAND }}");
  expect(workflow).toContain("Run structured provider acceptance cell");
  expect(workflow).toContain("name: provider-matrix-report-${{ matrix.cell }}");
});
