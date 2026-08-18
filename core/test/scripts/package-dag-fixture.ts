import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PackageEdges = {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

export type PackageDefinition = PackageEdges & {
  readonly exports?: string | Readonly<Record<string, string>>;
  readonly withoutTests?: boolean;
};

export type GateResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export interface PackageDagFixture {
  readonly root: string;
  readonly write: (path: string, contents: string) => Promise<void>;
  readonly writePackage: (directory: string, name: string, definition?: PackageDefinition) => Promise<void>;
  readonly writeRoot: (workspaces: readonly string[]) => Promise<void>;
  readonly runGate: (args: readonly string[]) => Promise<GateResult>;
  readonly dispose: () => Promise<void>;
}

export const createPackageDagFixture = async (): Promise<PackageDagFixture> => {
  const root = await mkdtemp(join(tmpdir(), "package-dag-"));
  const write = async (path: string, contents: string): Promise<void> => {
    const file = join(root, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, contents);
  };
  const writePackage = async (
    directory: string,
    name: string,
    definition: PackageDefinition = {},
  ): Promise<void> => {
    const { withoutTests = false, ...manifest } = definition;
    await write(`${directory}/package.json`, `${JSON.stringify({ name, ...manifest })}\n`);
    if (!withoutTests) await write(`${directory}/test/placeholder.test.ts`, "export {};\n");
  };
  const writeRoot = async (workspaces: readonly string[]): Promise<void> => {
    await write("package.json", `${JSON.stringify({ private: true, workspaces })}\n`);
  };
  const runGate = async (args: readonly string[]): Promise<GateResult> => {
    const repositoryRoot = join(import.meta.dirname, "../../..");
    const child = Bun.spawn(
      [process.execPath, "run", "scripts/check-package-dag.ts", ...args, "--root", root],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };

  await Promise.all([
    writeRoot([
      "core",
      "sdk",
      "container-runtime",
      "paths",
      "state-store",
      "landofile",
      "engine",
      "plugins/*",
    ]),
    writePackage("core", "@lando/core", {
      dependencies: {
        "@lando/container-runtime": "workspace:*",
        "@lando/paths": "workspace:*",
        "@lando/sdk": "workspace:*",
        "@lando/state-store": "workspace:*",
      },
    }),
    writePackage("sdk", "@lando/sdk"),
    writePackage("container-runtime", "@lando/container-runtime", {
      dependencies: { "@lando/sdk": "workspace:*" },
    }),
    writePackage("paths", "@lando/paths", { dependencies: { "@lando/sdk": "workspace:*" } }),
    writePackage("state-store", "@lando/state-store", {
      dependencies: { "@lando/paths": "workspace:*", "@lando/sdk": "workspace:*" },
    }),
    writePackage("landofile", "@lando/landofile", {
      dependencies: {
        "@lando/paths": "workspace:*",
        "@lando/sdk": "workspace:*",
        "@lando/state-store": "workspace:*",
      },
    }),
    writePackage("engine", "@lando/engine", {
      dependencies: {
        "@lando/container-runtime": "workspace:*",
        "@lando/landofile": "workspace:*",
        "@lando/paths": "workspace:*",
        "@lando/sdk": "workspace:*",
        "@lando/state-store": "workspace:*",
      },
    }),
    writePackage("plugins/provider-lando", "@lando/provider-lando", {
      dependencies: { "@lando/container-runtime": "workspace:*" },
      devDependencies: { "@lando/core": "workspace:*" },
    }),
    writePackage("plugins/provider-podman", "@lando/provider-podman", {
      dependencies: {
        "@lando/container-runtime": "workspace:*",
        "@lando/provider-lando": "workspace:*",
        "@lando/sdk": "workspace:*",
      },
    }),
    writePackage("plugins/service-lando", "@lando/service-lando", {
      devDependencies: { "@lando/core": "workspace:*" },
    }),
    writePackage("plugins/renderer-lando", "@lando/renderer-lando", {
      dependencies: { "@lando/sdk": "workspace:*" },
      devDependencies: { "@lando/paths": "workspace:*" },
    }),
  ]);

  return {
    root,
    write,
    writePackage,
    writeRoot,
    runGate,
    dispose: async () => rm(root, { recursive: true, force: true }),
  };
};
