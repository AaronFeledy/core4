import { expect } from "bun:test";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import * as Schema from "effect/Schema";

const directorySchema = Schema.Struct({ cwd: Schema.String, marker: Schema.String });
const normalize = (path: string): string =>
  process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;

export const expectHostDirectory = async (
  output: string,
  expected: typeof directorySchema.Type,
  pwd?: string,
) => {
  // Anchored output lines cannot be satisfied by PTY-echoed command input.
  const lines = output.replaceAll("\r", "").split("\n");
  const actualLines = lines.filter((line) => line.startsWith("ACTUAL="));
  expect(actualLines).toHaveLength(1);
  const actual = actualLines[0]?.slice("ACTUAL=".length) ?? "";
  expect(isAbsolute(actual)).toBe(true);
  // Windows also treats a current-drive-rooted path as absolute, but pwd must
  // report a fully qualified drive or UNC path, independent of the caller's cwd.
  if (process.platform === "win32") expect(parse(actual).root.length).toBeGreaterThan(1);
  const [actualPath, expectedPath, actualStat, expectedStat] = await Promise.all([
    realpath(actual),
    realpath(expected.cwd),
    stat(actual, { bigint: true }),
    stat(expected.cwd, { bigint: true }),
  ]);
  // A native child may preserve Windows 8.3 spelling while Lando uses realpath.
  // Both canonical names AND filesystem identity must agree; marker text alone
  // cannot distinguish a different directory containing a copied marker.
  expect(normalize(actualPath)).toBe(normalize(expectedPath));
  expect(actualStat.isDirectory()).toBe(true);
  expect(expectedStat.isDirectory()).toBe(true);
  expect([actualStat.dev, actualStat.ino]).toEqual([expectedStat.dev, expectedStat.ino]);
  // Synthesized PWD must use ACTUAL's path spelling, retaining the original
  // Windows slash/case tolerance. Authored PWD is a literal value instead.
  const pwdLines = lines.filter((line) => line.startsWith("ENV=<"));
  if (pwd === undefined) expect(pwdLines.map(normalize)).toEqual([normalize(`ENV=<${actual}>`)]);
  else expect(pwdLines).toEqual([`ENV=<${pwd}>`]);
  expect(lines.filter((line) => line.startsWith("IDENTITY="))).toEqual([`IDENTITY=${expected.marker}`]);
};

export const nativeHostDirectory = async (rawCwd: string, launch: string, env: NodeJS.ProcessEnv) => {
  // Let the OS interpret the raw cwd from the same launch directory as Lando.
  // Bun realpath(rawCwd) is NOT an oracle for symlink/.. traversal.
  const inspect =
    'console.log(JSON.stringify({cwd:process.cwd(),marker:require("node:fs").readFileSync(".host-marker","utf8")}))';
  const reference = await runCaptured(
    [
      process.execPath,
      "-e",
      `const p=Bun.spawnSync([process.execPath,"-e",${JSON.stringify(inspect)}],{cwd:${JSON.stringify(rawCwd)},env:{...process.env,BUN_BE_BUN:"1"}}); process.stdout.write(p.stdout); process.stderr.write(p.stderr); process.exit(p.exitCode);`,
    ],
    launch,
    { ...env, BUN_BE_BUN: "1" },
  );
  expect(reference.exitCode, reference.stderr).toBe(0);
  return Schema.decodeUnknownSync(directorySchema)(JSON.parse(reference.stdout));
};

const OUTPUT_LIMIT = 128 * 1024;
export const hostDirectoryProbe =
  'echo "ACTUAL=$(pwd)"; echo "ENV=<$PWD>"; bun -e \'console.log("IDENTITY="+require("node:fs").readFileSync(".host-marker","utf8"))\'';

export const runCaptured = async (cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
  const controller = new AbortController();
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env,
    signal: controller.signal,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > OUTPUT_LIMIT) {
        controller.abort();
        throw new RangeError("Host acceptance output exceeded its capture limit");
      }
    }
    return text + decoder.decode();
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capture(child.stdout),
      capture(child.stderr),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
};

export const runHostShellPty = async (
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  let output = "";
  let changed = Promise.withResolvers<void>();
  const decoder = new TextDecoder();
  const child = Bun.spawn({
    cmd: [binary, "shell", "--no-history", "--renderer=plain"],
    cwd,
    env,
    timeout: 30_000,
    terminal: {
      cols: 160,
      rows: 30,
      data: (_terminal, bytes) => {
        output = (output + decoder.decode(bytes, { stream: true })).slice(-OUTPUT_LIMIT);
        changed.resolve();
        changed = Promise.withResolvers<void>();
      },
    },
  });
  const exited = child.exited.then(() => {
    throw new Error(`Host shell exited before expected terminal output: ${output}`);
  });
  // The rejection is also consumed when exit is requested after the last output wait.
  void exited.catch(() => undefined);
  const waitFor = async (pattern: RegExp): Promise<void> => {
    while (!pattern.test(output)) await Promise.race([changed.promise, exited]);
  };
  try {
    await waitFor(/lando> /);
    child.terminal?.write(`${hostDirectoryProbe}\n`);
    await waitFor(/\r?\nIDENTITY=[^\r\n]+\r?\n[\s\S]*lando> /);
    child.terminal?.write("exit\n");
    expect(await child.exited, output).toBe(0);
    return output;
  } finally {
    child.terminal?.close();
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
};
