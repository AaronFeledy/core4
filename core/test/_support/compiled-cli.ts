import { resolve } from "node:path";

const coreRoot = resolve(import.meta.dirname, "../..");
const defaultCompiledCli = resolve(coreRoot, "dist/lando");

let compiledCliPromise: Promise<string> | undefined;

const compileCli = async (): Promise<string> => {
  const configuredCli = process.env.LANDO_TEST_COMPILED_CLI;
  if (configuredCli !== undefined) {
    const configuredPath = resolve(configuredCli);
    if (await Bun.file(configuredPath).exists()) return configuredPath;
  }

  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", "build:compile"],
    cwd: coreRoot,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(`build:compile failed with exit code ${exitCode}: ${stderr}`);
  }

  return defaultCompiledCli;
};

// Memoization alone is unsound here: suite-mates like
// core/test/build/no-runtime-tsbuildinfo.test.ts run `bun run clean`, which
// deletes core/dist/lando mid-suite. Re-verify the binary on every call and
// rebuild when it vanished, matching the old build-in-every-beforeAll safety.
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
