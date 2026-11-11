import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EngineCommandRunner,
  type LinuxBundleBuildEngine,
  type LinuxBundleBuildRequest,
  dockerBuildEngine,
  engineCommandRunner,
  landoRuntimeBuildEngine,
  selectLinuxBundleBuildEngine,
} from "../../../scripts/linux-runtime-bundle-engines.ts";

const request: LinuxBundleBuildRequest = {
  context: "/ctx",
  platform: "linux/amd64",
  buildArgs: ["BUNDLE_PLATFORM=linux-x64", "REPOSITORY=owner/repo"],
  exportDir: "/export",
  artifactName: "lando-runtime-linux-x64.tar.gz",
};

/** Records every command; `capture` answers from `outputs` and `fail` makes a matching command reject. */
const recordingRunner = (options: {
  readonly outputs?: Readonly<Record<string, string>>;
  readonly fail?: (cmd: ReadonlyArray<string>) => boolean;
}) => {
  const calls: string[][] = [];
  const answer = (cmd: ReadonlyArray<string>): void => {
    calls.push([...cmd]);
    if (options.fail?.(cmd)) throw new Error(`injected failure: ${cmd.join(" ")}`);
  };
  const runner: EngineCommandRunner = {
    execute: async (cmd) => answer(cmd),
    capture: async (cmd) => {
      answer(cmd);
      const verb = cmd.find((arg) => ["create", "info", "version", "buildx"].includes(arg)) ?? "";
      return options.outputs?.[verb] ?? "";
    },
  };
  return { runner, calls };
};

const withLandoRuntime = async (
  run: (paths: { runtimeBinDir: string; providerSocketPath: string }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "rb-engine-"));
  try {
    const runtimeBinDir = join(root, "bin");
    await mkdir(runtimeBinDir);
    await writeFile(join(runtimeBinDir, "podman"), "#!/bin/sh\n");
    await chmod(join(runtimeBinDir, "podman"), 0o755);
    await run({ runtimeBinDir, providerSocketPath: join(root, "podman.sock") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("Linux runtime bundle build engines", () => {
  test("Docker requires Buildx, reports the daemon platform, and exports the bundle target locally", async () => {
    const { runner, calls } = recordingRunner({ outputs: { version: "linux/amd64" } });
    const engine = dockerBuildEngine(runner);

    expect(await engine.probe()).toBe("linux/amd64");
    expect(calls).toEqual([
      ["docker", "buildx", "version"],
      ["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
    ]);

    await engine.build(request);
    expect(calls.at(-1)).toEqual([
      "docker",
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--target",
      "bundle",
      "--output",
      "type=local,dest=/export",
      "--build-arg",
      "BUNDLE_PLATFORM=linux-x64",
      "--build-arg",
      "REPOSITORY=owner/repo",
      "--file",
      "/ctx/Dockerfile",
      "/ctx",
    ]);
  });

  test("the Lando runtime builds through its managed API, copies the archive out, and removes what it created", async () => {
    await withLandoRuntime(async (paths) => {
      const { runner, calls } = recordingRunner({ outputs: { info: "linux/amd64", create: "ctr1" } });
      const engine = landoRuntimeBuildEngine(runner, paths);
      const podman = [
        join(paths.runtimeBinDir, "podman"),
        "--remote",
        "--url",
        `unix://${paths.providerSocketPath}`,
      ];

      expect(await engine.probe()).toBe("linux/amd64");
      expect(calls[0]).toEqual([...podman, "info", "--format", "{{.Host.OS}}/{{.Host.Arch}}"]);

      await engine.build(request);
      const [build, create, copy, remove, untag] = calls.slice(1);
      const tag = build?.[build.indexOf("--tag") + 1] ?? "";
      expect(tag).toMatch(/^localhost\/lando-runtime-bundle-builder:[0-9a-f-]{36}$/u);
      expect(build).toEqual([
        ...podman,
        "build",
        "--platform",
        "linux/amd64",
        "--target",
        "bundle",
        "--format",
        "docker",
        "--tag",
        tag,
        "--build-arg",
        "BUILDPLATFORM=linux/amd64",
        "--build-arg",
        "BUNDLE_PLATFORM=linux-x64",
        "--build-arg",
        "REPOSITORY=owner/repo",
        "--file",
        "/ctx/Dockerfile",
        "/ctx",
      ]);
      expect(create).toEqual([...podman, "create", tag, "/lando-bundle-export"]);
      expect(copy).toEqual([...podman, "cp", "ctr1:/lando-runtime-linux-x64.tar.gz", "/export"]);
      expect(remove).toEqual([...podman, "rm", "--force", "ctr1"]);
      expect(untag).toEqual([...podman, "rmi", tag]);
    });
  });

  test("the Lando runtime still removes its container and image when the copy fails, and keeps the copy error", async () => {
    await withLandoRuntime(async (paths) => {
      const { runner, calls } = recordingRunner({
        outputs: { create: "ctr1" },
        fail: (cmd) => cmd.includes("cp"),
      });
      await expect(landoRuntimeBuildEngine(runner, paths).build(request)).rejects.toThrow("injected failure");
      expect(calls.map((cmd) => cmd[4])).toEqual(["build", "create", "cp", "rm", "rmi"]);
    });
  });

  test("the Lando runtime cleans up nothing when the build itself fails", async () => {
    await withLandoRuntime(async (paths) => {
      const { runner, calls } = recordingRunner({ fail: (cmd) => cmd.includes("build") });
      await expect(landoRuntimeBuildEngine(runner, paths).build(request)).rejects.toThrow("injected failure");
      expect(calls.map((cmd) => cmd[4])).toEqual(["build"]);
    });
  });

  test("the Lando runtime is unavailable without its runtime client", async () => {
    const { runner, calls } = recordingRunner({});
    const engine = landoRuntimeBuildEngine(runner, {
      runtimeBinDir: "/nonexistent/lando/runtime/bin",
      providerSocketPath: "/nonexistent/podman.sock",
    });
    await expect(engine.probe()).rejects.toThrow(
      "no Lando runtime client at /nonexistent/lando/runtime/bin/podman",
    );
    expect(calls).toEqual([]);
  });

  describe("engine selection", () => {
    const engine = (
      id: LinuxBundleBuildEngine["id"],
      probe: () => Promise<string>,
    ): LinuxBundleBuildEngine => ({
      id,
      probe,
      build: async () => {},
    });
    const unavailable = (reason: string) => async (): Promise<string> => {
      throw new Error(`${reason}\nmore detail`);
    };
    const select = (
      engines: Record<LinuxBundleBuildEngine["id"], LinuxBundleBuildEngine>,
      requested?: LinuxBundleBuildEngine["id"],
      platform = "linux/amd64",
    ) => selectLinuxBundleBuildEngine({ hostKey: "linux-x64", platform, requested, engines });

    test("prefers Docker Buildx and falls back to the Lando runtime", async () => {
      const both = {
        docker: engine("docker", async () => "linux/amd64"),
        lando: engine("lando", async () => "linux/amd64"),
      };
      expect((await select(both)).id).toBe("docker");
      const landoOnly = { ...both, docker: engine("docker", unavailable("buildx missing")) };
      expect((await select(landoOnly)).id).toBe("lando");
    });

    test("probes only the engine that --engine names", async () => {
      let dockerProbed = false;
      const engines = {
        docker: engine("docker", async () => {
          dockerProbed = true;
          return "linux/amd64";
        }),
        lando: engine("lando", async () => "linux/amd64"),
      };
      expect((await select(engines, "lando")).id).toBe("lando");
      expect(dockerProbed).toBe(false);
    });

    test("never selects an engine that would emulate the target platform", async () => {
      const engines = {
        docker: engine("docker", async () => "linux/amd64"),
        lando: engine("lando", async () => "linux/amd64"),
      };
      await expect(select(engines, undefined, "linux/arm64")).rejects.toThrow(
        "docker: builds on linux/amd64, not linux/arm64",
      );
    });

    test("explains how to make each engine available when none can build", async () => {
      const engines = {
        docker: engine("docker", unavailable("docker: command not found")),
        lando: engine("lando", unavailable("no Lando runtime client at /x/podman")),
      };
      const failure = select(engines);
      await expect(failure).rejects.toThrow(
        [
          "assemble-runtime-bundle: linux-x64 builds in a container, and no native linux/amd64 build engine is available.",
          "  docker: docker: command not found. Install Docker Engine with the Buildx plugin.",
          "  lando: no Lando runtime client at /x/podman. Run `lando setup`, then start the Lando runtime with `lando global:start`.",
          "Choose one with --engine docker or --engine lando.",
        ].join("\n"),
      );
      await expect(select(engines, "docker")).rejects.toThrow(/Buildx plugin\.$/u);
    });
  });

  test("the command runner returns trimmed stdout and rejects with stderr", async () => {
    const runner = engineCommandRunner({ PATH: process.env.PATH ?? "/usr/bin:/bin" });
    expect(await runner.capture(["sh", "-c", "printf ' linux/amd64\\n'"])).toBe("linux/amd64");
    await expect(runner.capture(["sh", "-c", "echo 'socket refused' >&2; exit 3"])).rejects.toThrow(
      "socket refused",
    );
    await expect(runner.execute(["sh", "-c", "exit 4"])).rejects.toThrow("command failed (4)");
  });
});
