import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { providerStatePath } from "@lando/provider-lando";
import type { PluginDoctorCheckContribution } from "@lando/sdk/plugins";

import { manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id));

const temporaryDirectories: string[] = [];

const makeStateDir = async (): Promise<string> => {
  const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-podman-plugin-"));
  temporaryDirectories.push(stateDir);
  return stateDir;
};

const doctorCheck = (): PluginDoctorCheckContribution => {
  const check = plugin.doctorChecks?.[0];
  if (check === undefined) throw new Error("expected provider-podman to contribute a doctor check");
  return check;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("@lando/provider-podman plugin descriptor", () => {
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
  });

  test("runtimeProviders keys match manifest.contributes.providers", () => {
    // Given
    const manifestProviderIds = contributionIds(manifest.contributes?.providers);

    // When
    const runtimeProviderIds = [...(plugin.runtimeProviders?.keys() ?? [])].map(String);

    // Then
    expect(runtimeProviderIds).toEqual([...manifestProviderIds]);
  });

  test("contributes a provider conflict doctor check", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.doctorChecks).toHaveLength(1);
    expect(doctorCheck().id).toBe("provider-conflict");
  });

  test("conflict check returns no reports when stateDir is unavailable", async () => {
    // Given / When
    const reports = await Effect.runPromise(
      doctorCheck().run({
        providerId: "podman",
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        userDataRoot: undefined,
        stateDir: undefined,
      }),
    );

    // Then
    expect(reports).toEqual([]);
  });

  test("conflict check returns a preemptive report matching the current doctor shape", async () => {
    // Given
    const stateDir = await makeStateDir();
    const socketPath = "/run/user/1000/podman/podman.sock";
    const statePath = providerStatePath(stateDir);
    await mkdir(join(stateDir, "provider-lando"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ socketPath }), "utf8");

    // When
    const reports = await Effect.runPromise(
      doctorCheck().run({
        providerId: "podman",
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        userDataRoot: undefined,
        stateDir,
      }),
    );

    // Then
    expect(reports).toEqual([
      {
        name: "provider-conflict",
        status: "warn",
        severity: "warn",
        runtimeStatus: "conflict",
        runtime: { running: false },
        context: {
          providerId: "podman",
          providerKind: "user-installed",
          providerVersion: "unknown",
          runtimeStatus: "conflict",
          platform: "linux",
          conflictKind: "provider-lando-podman-socket",
          socketPath,
          providerLandoStatePath: statePath,
        },
        solutions: [
          {
            kind: "manual",
            description:
              "Choose one provider explicitly. Run `lando setup --provider=podman` to switch to the user-installed Podman, or `lando setup --provider=lando` to keep the Lando-managed runtime. Alternatively, set `provider:` in your Landofile.",
            command: "lando setup --provider=podman",
          },
        ],
        preempts: true,
      },
    ]);
  });

  test("conflict check returns no preemptive report when sockets differ", async () => {
    // Given
    const stateDir = await makeStateDir();
    await mkdir(join(stateDir, "provider-lando"), { recursive: true });
    await writeFile(
      providerStatePath(stateDir),
      JSON.stringify({ socketPath: "/run/user/1000/podman/other.sock" }),
      "utf8",
    );

    // When
    const reports = await Effect.runPromise(
      doctorCheck().run({
        providerId: "podman",
        platform: "linux",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
        userDataRoot: undefined,
        stateDir,
      }),
    );

    // Then
    expect(reports.filter((report) => report.preempts === true)).toEqual([]);
  });
});
