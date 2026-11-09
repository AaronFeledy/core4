import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLinuxBootId } from "@lando/container-runtime/podman/managed-status-io";
import { RUNTIME_SHUTDOWN_KEY } from "@lando/container-runtime/podman/runtime-shutdown";
import { makeLandoPaths } from "@lando/paths";
import { Effect } from "effect";
import { discoverRunningAppsEvidenceFromSockets } from "../../src/cli/commands/list-discovery.ts";

test.each([
  "HTTP failure",
  "malformed JSON",
  "invalid inventory",
  "HTTP failure then endpoint disappears",
] as const)("list keeps runtime unknown after %s even with stopped-machine evidence", async (failure) => {
  const root = await mkdtemp(join(tmpdir(), "lando-list-endpoint-"));
  const paths = makeLandoPaths({ userDataRoot: root });
  await mkdir(paths.runtimeRunDir, { recursive: true });
  let removal: Promise<void> | undefined;
  const server = createServer(async (_request, response) => {
    if (failure === "HTTP failure then endpoint disappears") {
      removal ??= unlink(paths.providerSocketPath);
      await removal;
    }
    response.writeHead(failure === "malformed JSON" || failure === "invalid inventory" ? 200 : 503, {
      Connection: "close",
    });
    response.end(failure === "invalid inventory" ? "{}" : "invalid-json");
  });
  try {
    await new Promise<void>((resolve) => server.listen(paths.providerSocketPath, resolve));
    let inspections = 0;
    const evidence = await discoverRunningAppsEvidenceFromSockets(root, [paths.providerSocketPath], {
      platform: "darwin",
      processRunner: {
        run: () => {
          inspections += 1;
          return Effect.succeed({ exitCode: 0, stdout: '[{"State":"stopped"}]', stderr: "" });
        },
      },
    });
    expect(evidence).toMatchObject({ confirmedProviderIds: [], idleProviderIds: [], ownedAppIds: [] });
    expect(inspections).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed Linux runtime with an absent endpoint is unknown, never stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-list-silent-"));
  try {
    const paths = makeLandoPaths({ userDataRoot: root });
    await mkdir(paths.runtimeBinDir, { recursive: true });
    await writeFile(join(paths.runtimeBinDir, ".runtime-installed-version"), "0.1.7");
    await writeFile(join(paths.runtimeBinDir, "podman"), "", { mode: 0o755 });
    const evidence = await discoverRunningAppsEvidenceFromSockets(root, [paths.providerSocketPath], {
      platform: "linux",
    });
    expect(evidence).toMatchObject({ confirmedProviderIds: [], idleProviderIds: [], ownedAppIds: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["stopped", "admitted", "previous-boot", "corrupt"] as const)(
  "Linux list discovery uses %s receipt evidence",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "lando-list-receipt-"));
    try {
      const paths = makeLandoPaths({ userDataRoot: root });
      await mkdir(paths.runtimeBinDir, { recursive: true });
      const pluginRoot = paths.pluginStateDir("@lando/provider-lando");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(paths.runtimeBinDir, ".runtime-installed-version"), "0.1.7");
      await writeFile(join(paths.runtimeBinDir, "podman"), "", { mode: 0o755 });
      const bootId = await Effect.runPromise(readLinuxBootId());
      await writeFile(
        join(pluginRoot, RUNTIME_SHUTDOWN_KEY),
        state === "corrupt"
          ? "{"
          : JSON.stringify({
              version: 1,
              data: {
                generation: "g",
                bootId: state === "previous-boot" ? `${bootId}-previous` : bootId,
                state: state === "stopped" ? "stopped" : "admitted",
              },
            }),
      );
      const evidence = await discoverRunningAppsEvidenceFromSockets(root, [paths.providerSocketPath], {
        platform: "linux",
      });
      expect(evidence).toMatchObject({
        confirmedProviderIds: [],
        idleProviderIds: state === "stopped" || state === "previous-boot" ? ["lando"] : [],
        ownedAppIds: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
