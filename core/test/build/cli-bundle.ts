import { join, resolve } from "node:path";

import { opentuiNativeCatalog } from "../../../scripts/generated/opentui-native/catalog.generated.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const binaryEntry = resolve(repoRoot, "core/bin/lando.ts");

const hostTarget = (): keyof typeof opentuiNativeCatalog.targetToNativeRoot => {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  throw new Error(`Unsupported CLI bundle host: ${process.platform}-${process.arch}.`);
};

export const buildCliBundle = async (outdir: string, version?: string): Promise<string> => {
  const target = hostTarget();
  const nativeRoot = opentuiNativeCatalog.targetToNativeRoot[target];
  const cmd = [
    process.execPath,
    "build",
    binaryEntry,
    "--outdir",
    outdir,
    "--target",
    "bun",
    `--define=__LANDO_OPENTUI_NATIVE_ROOT__=${JSON.stringify(nativeRoot)}`,
    ...opentuiNativeCatalog.allNativeRoots
      .filter((root) => root !== nativeRoot)
      .map((root) => `--external=${root}`),
  ];
  if (version !== undefined) cmd.push(`--define=__LANDO_CORE_VERSION__=${JSON.stringify(version)}`);

  const proc = Bun.spawn({
    cmd,
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Unable to build CLI bundle:\n${stderr}`);
  return join(outdir, "lando.js");
};
