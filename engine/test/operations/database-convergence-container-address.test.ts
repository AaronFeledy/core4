import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerAddress } from "../../src/operations/database-convergence/container-address.ts";

const executable = async (path: string, body: string) => {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
};

const resolveAddress = async (getent: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-container-address-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    await executable(join(bin, "cat"), 'printf "runtime-host\\n"');
    await executable(join(bin, "getent"), getent);
    const child = Bun.spawnSync(["/bin/sh", "-c", `${containerAddress}\ncontainer_address`], {
      env: { PATH: bin },
    });
    return {
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      exitCode: child.exitCode,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.skipIf(process.platform === "win32").each([
  {
    name: "resolves the runtime IPv4 without a hostname binary",
    getent: 'printf "127.0.0.1 STREAM localhost\\n10.11.12.13 STREAM runtime-host\\n"',
    stdout: "10.11.12.13\n",
  },
  {
    name: "returns no address when resolution reports only loopback or non-IPv4 rows",
    getent:
      'printf "127.0.0.1 STREAM localhost\\n::1 STREAM localhost\\nruntime-host STREAM runtime-host\\n"',
    stdout: "",
  },
  { name: "returns no address when name resolution fails", getent: "exit 1", stdout: "" },
])("$name", async ({ getent, stdout }) => {
  expect(await resolveAddress(getent)).toEqual({ stdout, stderr: "", exitCode: 0 });
});
