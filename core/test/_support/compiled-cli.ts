import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const coreRoot = resolve(import.meta.dirname, "../..");
const scriptsRoot = resolve(coreRoot, "../scripts");
/** One shared binary per checkout, outside it, so test processes neither leak copies nor touch core/dist. */
const compiledCliDir = join(
  tmpdir(),
  `lando-test-compiled-cli-${createHash("sha256").update(coreRoot).digest("hex").slice(0, 12)}`,
);

const runBuildStep = async (
  cmd: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
) => {
  const subprocess = Bun.spawn({ cmd: [...cmd], cwd: coreRoot, env, stdout: "ignore", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
  if (exitCode !== 0)
    throw new Error(`${cmd.slice(1).join(" ")} failed with exit code ${exitCode}: ${stderr}`);
};

/**
 * Compiles the CLI with the same steps and flags as `build:compile`, into `outfile`. Tests never
 * write `core/dist/lando`: developer tooling and e2e runners execute that binary, and a test
 * build (often embedding stub helpers) would silently replace it.
 */
export const compileCliTo = async (
  outfile: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  await runBuildStep(
    [
      process.execPath,
      resolve(scriptsRoot, "build-compiled-binary.ts"),
      "--outfile",
      outfile,
      "--minify",
      "--sourcemap=external",
    ],
    env,
  );
  await runBuildStep([process.execPath, resolve(scriptsRoot, "sanitize-compiled-binary.ts"), outfile], env);
};

let compiledCliPromise: Promise<string> | undefined;

const compileCli = async (): Promise<string> => {
  const configuredCli = process.env.LANDO_TEST_COMPILED_CLI;
  if (configuredCli !== undefined) {
    const configuredPath = resolve(configuredCli);
    if (await Bun.file(configuredPath).exists()) return configuredPath;
  }

  // Concurrent test processes each build privately, then rename one complete binary into place.
  await mkdir(compiledCliDir, { recursive: true });
  const staging = await mkdtemp(join(compiledCliDir, ".build-"));
  const binaryName = process.platform === "win32" ? "lando.exe" : "lando";
  const compiledCli = join(compiledCliDir, binaryName);
  try {
    await compileCliTo(join(staging, binaryName));
    await rename(join(staging, binaryName), compiledCli);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return compiledCli;
};

// Memoization alone is unsound when another build or clean removes the binary.
// Re-verify it on every call and rebuild when it vanished, matching the old
// build-in-every-beforeAll safety.
export const ensureCompiledCli = async (): Promise<string> => {
  if (compiledCliPromise === undefined) {
    compiledCliPromise = compileCli();
  }
  const pending = compiledCliPromise;
  const compiledCli = await pending;
  if (await Bun.file(compiledCli).exists()) {
    return compiledCli;
  }
  if (compiledCliPromise === pending) {
    compiledCliPromise = compileCli();
  }
  return await compiledCliPromise;
};
