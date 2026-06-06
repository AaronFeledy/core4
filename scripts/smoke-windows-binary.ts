#!/usr/bin/env bun

import { existsSync } from "node:fs";

const SMOKE_SUBCOMMANDS = [["--version"], ["--help"], ["shellenv"]] as const;
const BOGUS_SUBCOMMAND = ["__lando_windows_smoke_unknown__"] as const;

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const runBinary = async (
  binaryPath: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  const proc = Bun.spawn([binaryPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdoutBytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await new Response(proc.stderr).arrayBuffer();
  const exitCode = await proc.exited;
  return { exitCode, stdout: decodeUtf8(stdoutBytes) };
};

export const smokeWindowsBinary = async (binaryPath: string): Promise<void> => {
  if (!existsSync(binaryPath)) {
    throw new Error(`smoke target does not exist: ${binaryPath}`);
  }

  for (const args of SMOKE_SUBCOMMANDS) {
    const { exitCode, stdout } = await runBinary(binaryPath, args);
    if (exitCode !== 0) {
      throw new Error(`expected exit 0 for \`${args.join(" ")}\`, got ${exitCode}`);
    }
    if (stdout.trim().length === 0) {
      throw new Error(`expected non-empty UTF-8 stdout for \`${args.join(" ")}\``);
    }
  }

  const bogus = await runBinary(binaryPath, BOGUS_SUBCOMMAND);
  if (bogus.exitCode === 0) {
    throw new Error(`expected non-zero exit for \`${BOGUS_SUBCOMMAND.join(" ")}\`, got 0`);
  }
};

if (import.meta.main) {
  const [binaryPath] = Bun.argv.slice(2);
  if (binaryPath === undefined) {
    console.error("Usage: smoke-windows-binary.ts <binary-path>");
    process.exit(1);
  }

  try {
    await smokeWindowsBinary(binaryPath);
    console.log(`smoke ok: ${binaryPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
