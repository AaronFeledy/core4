import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkLibpodPrefix } from "./check-libpod-prefix.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "libpod-prefix-"));
  await mkdir(join(root, "plugins", "provider-lando", "src"), { recursive: true });
  await mkdir(join(root, "plugins", "provider-lando", "test"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeSrc = async (name: string, contents: string): Promise<string> => {
  const file = join(root, "plugins", "provider-lando", "src", name);
  await writeFile(file, contents);
  return `plugins/provider-lando/src/${name}`;
};

describe("check-libpod-prefix", () => {
  test('flags an apiPrefix: "/v5.0.0" literal in production source', async () => {
    const rel = await writeSrc("a.ts", `export const client = { apiPrefix: "/v5.0.0" };\n`);
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.file)).toContain(rel);
    expect(result.offenders.map((o) => o.match)).toContain("/v5.0.0");
  });

  test("flags a http://localhost/v5.0.0 URL in production source", async () => {
    const rel = await writeSrc("b.ts", `export const url = "http://localhost/v5.0.0/libpod/info";\n`);
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.file)).toContain(rel);
  });

  test("flags a templated http://localhost/v5.0.0${path} URL in production source", async () => {
    await writeSrc("c.ts", "export const url = (path: string) => `http://localhost/v5.0.0${path}`;\n");
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(false);
  });

  test("passes when production source uses the /v6.0.0 prefix", async () => {
    await writeSrc(
      "ok.ts",
      `export const client = { apiPrefix: "/v6.0.0" };\nexport const url = "http://localhost/v6.0.0/libpod/info";\n`,
    );
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(true);
    expect(result.offenders).toEqual([]);
  });

  test("ignores .test.ts files", async () => {
    await writeSrc("d.test.ts", `export const url = "http://localhost/v5.0.0/libpod/info";\n`);
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(true);
  });

  test("ignores files under a test directory", async () => {
    await writeFile(
      join(root, "plugins", "provider-lando", "test", "fixture.ts"),
      `export const url = "http://localhost/v5.0.0/libpod/info";\n`,
    );
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(true);
  });

  test("reports offenders across multiple provider plugins", async () => {
    await mkdir(join(root, "plugins", "provider-podman", "src"), { recursive: true });
    await writeFile(
      join(root, "plugins", "provider-podman", "src", "named-pipe.ts"),
      `export const client = { apiPrefix: "/v5.0.0" };\n`,
    );
    await writeSrc("e.ts", `export const client = { apiPrefix: "/v5.0.0" };\n`);
    const result = await checkLibpodPrefix({ root });
    expect(result.ok).toBe(false);
    expect(result.offenders.map((o) => o.file).sort()).toEqual([
      "plugins/provider-lando/src/e.ts",
      "plugins/provider-podman/src/named-pipe.ts",
    ]);
  });
});
