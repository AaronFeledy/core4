import { expect, test } from "bun:test";
import {
  containerHelperGoArch,
  logFileHelperCleanupArgv,
  logFileHelperExecArgv,
} from "@lando/container-runtime/container-helper";

test("log-file argv preserves the executable path as one argument", () => {
  const path = "/tmp/helper with spaces/$(untrusted)/lando-container-helper";
  expect(logFileHelperExecArgv(path)).toEqual([path, "log-file"]);
});

test("cleanup argv preserves executable and directory argument boundaries", () => {
  const path = "/tmp/helper with spaces/lando-container-helper";
  const directory = "/tmp/helper with spaces/$(untrusted)";
  expect(logFileHelperCleanupArgv(path, directory)).toEqual([path, "log-file-cleanup", directory]);
});

test.each([
  ["x64", "amd64"],
  ["arm64", "arm64"],
] as const)("maps helper architecture %s to Go architecture %s", (arch, expected) => {
  expect(containerHelperGoArch(arch)).toBe(expected);
});
