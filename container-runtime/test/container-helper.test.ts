import { expect, test } from "bun:test";
import { containerHelperGoArch, logFileHelperExecArgv } from "@lando/container-runtime/container-helper";

test("log-file argv preserves the executable path as one argument", () => {
  const path = "/tmp/helper with spaces/$(untrusted)/lando-container-helper";
  expect(logFileHelperExecArgv(path)).toEqual([path, "log-file"]);
});

test.each([
  ["x64", "amd64"],
  ["arm64", "arm64"],
] as const)("maps helper architecture %s to Go architecture %s", (arch, expected) => {
  expect(containerHelperGoArch(arch)).toBe(expected);
});
