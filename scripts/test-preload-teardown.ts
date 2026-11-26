import { afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { installProcessTestRoots, releaseCreatedTestRoots } from "./test-preload-roots.ts";

// Bun 1.4 rewrites process.argv to the current file and leaves --isolate, --rerun-each and
// --parallel out of execArgv. Only Linux exposes the full invocation, so other hosts keep
// their tree rather than risk removing it while a later file or rerun still uses it.
const invocationArgs = (): readonly string[] | undefined => {
  if (process.platform !== "linux") return undefined;
  try {
    const parts = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  } catch {
    return undefined;
  }
};

const isSkipFlag = (arg: string): boolean =>
  arg === "--test-worker" ||
  arg === "--isolate" ||
  ["--bail", "--parallel", "--rerun-each"].some((flag) => arg === flag || arg.startsWith(`${flag}=`));

const serialTestProcessTeardownIsFinal = (): boolean => {
  if (process.env.BUN_TEST_WORKER_ID !== undefined) return false;
  const args = invocationArgs();
  return args !== undefined && !args.some(isSkipFlag);
};

installProcessTestRoots();
if (serialTestProcessTeardownIsFinal()) afterAll(releaseCreatedTestRoots);
