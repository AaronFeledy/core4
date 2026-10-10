import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUGO_BUILD_ARTIFACT } from "../../src/recipes/builtin/hugo/install.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async (architecture: string) => {
  const root = await mkdtemp(join(tmpdir(), "hugo-install-"));
  roots.push(root);
  await Bun.write(join(root, "dpkg"), `#!/bin/sh\nprintf '%s\\n' '${architecture}'\n`);
  await chmod(join(root, "dpkg"), 0o755);
  return { root, env: { ...process.env, PATH: `${root}:${process.env.PATH}` } };
};

test.each([
  ["amd64", "0163f5c3deddac1f494a1629ddc40c65d18de9d5794facd98f7f96ac2c7d8957"],
  ["arm64", "c73eaba13738754b50de4d07606670d5c0cd2eaaf2057af657cec9efd3b01876"],
])("selects the official extended archive checksum for Linux %s", async (architecture, checksum) => {
  // Given the builder architecture reported by dpkg.
  const { env } = await fixture(architecture);
  const selection = HUGO_BUILD_ARTIFACT[1].split('work="')[0];

  // When the install script selects its pinned archive before any download.
  const process = Bun.spawn(["sh", "-c", `${selection}\nprintf '%s\\n%s\\n' "$archive" "$checksum"`], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(process.stdout).text();

  // Then each supported architecture gets its own official extended pin.
  expect(await process.exited).toBe(0);
  expect(output.trim().split("\n")).toEqual([`hugo_extended_0.167.0_linux-${architecture}.tar.gz`, checksum]);
});

test("rejects an unsupported Linux architecture before downloading", async () => {
  // Given a builder outside the two published Linux architecture pins.
  const { env } = await fixture("s390x");

  // When its image artifact install runs.
  const process = Bun.spawn(["sh", "-c", HUGO_BUILD_ARTIFACT[1]], { env, stderr: "pipe" });

  // Then the selection fails closed, rather than downloading another architecture.
  expect(await process.exited).toBe(1);
  expect(await new Response(process.stderr).text()).toContain("Unsupported Hugo Linux architecture");
});

test("refuses a corrupted download before extracting or installing Hugo", async () => {
  // Given a downloader returning bytes that do not match the official pin.
  const { root, env } = await fixture("amd64");
  await Bun.write(
    join(root, "curl"),
    '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf corrupt > "$2"\n',
  );
  const marker = join(root, "extracted-or-installed");
  for (const tool of ["tar", "install"]) {
    await Bun.write(join(root, tool), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(join(root, tool), 0o755);
  }
  await chmod(join(root, "curl"), 0o755);

  // When the artifact command verifies the download using real sha256sum.
  const process = Bun.spawn(["sh", "-c", HUGO_BUILD_ARTIFACT[1]], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(process.stdout).text();
  const error = await new Response(process.stderr).text();

  // Then checksum failure prevents both extraction and installation.
  expect(await process.exited).toBe(1);
  expect(output).toContain("FAILED");
  expect(error).toContain("checksum did NOT match");
  expect(await Bun.file(marker).exists()).toBe(false);
});
