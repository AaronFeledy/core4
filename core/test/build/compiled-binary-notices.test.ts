import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  CompiledBinaryLicenseError,
  discoverBundledPackageRoots,
  isPermissiveLicense,
  readPackageLicense,
  renderPackageLicense,
} from "../../../scripts/compiled-binary-licenses.ts";
import {
  BUN_LICENSE_PIN,
  verifyBunCompilerVersion,
  verifyBunLicensePin,
} from "../../../scripts/compiled-binary-notices.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const packageFixture = async (license?: string): Promise<string> => {
  const root = await mkdtemp(resolve(tmpdir(), "lando-binary-license-"));
  roots.push(root);
  await Bun.write(
    resolve(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.2.3",
      repository: { url: "https://example.com/fixture" },
      ...(license === undefined ? {} : { license }),
    }),
  );
  return root;
};

describe("compiled binary notices", () => {
  test("discovers contributing scoped and nested packages while excluding workspace and tree-shaken inputs", async () => {
    const root = await packageFixture("MIT");
    const fixture = {
      outputs: {
        "lando.js": {
          bytes: 100,
          imports: [],
          exports: [],
          inputs: {
            "node_modules/@example/native/lib.so": { bytesInOutput: 20 },
            "node_modules/parent/index.js": { bytesInOutput: 20 },
            "node_modules/parent/node_modules/child/index.js": { bytesInOutput: 20 },
            "node_modules/unused/index.js": { bytesInOutput: 0 },
            "node_modules/@lando/fixture/index.ts": { bytesInOutput: 20 },
            "src/local.ts": { bytesInOutput: 20 },
          },
        },
      },
    } satisfies Pick<Bun.BuildMetafile, "outputs">;
    for (const name of ["@example/native", "parent", "parent/node_modules/child", "unused"]) {
      await Bun.write(
        resolve(root, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "1.0.0" }),
      );
    }
    await Bun.write(
      resolve(root, "workspace/package.json"),
      JSON.stringify({ name: "@lando/fixture", version: "0.0.0" }),
    );
    await Bun.write(resolve(root, "node_modules/@lando/.keep"), "");
    await symlink(resolve(root, "workspace"), resolve(root, "node_modules/@lando/fixture"), "junction");

    const found = await discoverBundledPackageRoots(fixture, root);

    expect(found).toEqual(
      ["@example/native", "parent", "parent/node_modules/child"]
        .map((name) => resolve(root, "node_modules", name))
        .sort(),
    );
  });

  test("resolves metafile paths relative to a workspace build directory", async () => {
    const root = await packageFixture("MIT");
    await Bun.write(
      resolve(root, "node_modules/fixture/package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    const fixture = {
      outputs: {
        "out.js": {
          bytes: 1,
          imports: [],
          exports: [],
          inputs: { "../node_modules/fixture/index.js": { bytesInOutput: 1 } },
        },
      },
    } satisfies Pick<Bun.BuildMetafile, "outputs">;

    const found = await discoverBundledPackageRoots(fixture, resolve(root, "core"));

    expect(found).toEqual([resolve(root, "node_modules/fixture")]);
  });

  test("copies every package license and notice verbatim, including nested files", async () => {
    const root = await packageFixture("MIT");
    const bytes = "fixture copyright\r\n  preserve spacing and UTF-8: ©\r\n";
    await Bun.write(resolve(root, "LICENSE.txt"), bytes);
    await Bun.write(resolve(root, "licenses/NOTICE.extra"), "fixture notice without final newline");
    await Bun.write(resolve(root, "licenses/COPYING"), "fixture copying");

    const pkg = await readPackageLicense(root);
    const rendered = renderPackageLicense(pkg);

    expect(pkg.files).toEqual([
      { path: "LICENSE.txt", text: bytes },
      { path: "licenses/COPYING", text: "fixture copying" },
      { path: "licenses/NOTICE.extra", text: "fixture notice without final newline" },
    ]);
    expect(rendered).toContain(bytes);
    expect(rendered).toContain("fixture notice without final newline");
    expect(pkg.repository).toBe("https://example.com/fixture");
  });

  test("records SPDX and source when a package ships no license file", async () => {
    const root = await packageFixture("ISC");

    const pkg = await readPackageLicense(root);

    expect(pkg).toMatchObject({
      name: "fixture",
      version: "1.2.3",
      license: "ISC",
      repository: "https://example.com/fixture",
      files: [],
    });
  });

  test("fails when both license metadata and files are missing", async () => {
    const root = await packageFixture();

    const result = readPackageLicense(root);

    await expect(result).rejects.toBeInstanceOf(CompiledBinaryLicenseError);
    await expect(result).rejects.toThrow("missing license field and license files");
  });

  test("fails closed on copyleft even with a shipped license file", async () => {
    const root = await packageFixture("GPL-3.0-only");
    await Bun.write(resolve(root, "LICENSE"), "fixture copyleft license");

    const result = readPackageLicense(root);

    await expect(result).rejects.toThrow("disallowed or undeclared SPDX license GPL-3.0-only");
  });

  test.each(["MIT", "(MIT OR Apache-2.0)", "MIT AND (ISC OR BSD-3-Clause)"])(
    "accepts permissive SPDX expression %s",
    (license) => {
      expect(isPermissiveLicense(license)).toBe(true);
    },
  );

  test.each(["", "MIT OR GPL-2.0-only", "MIT WITH LLVM-exception", "(MIT", "MIT ISC", "MIT OR", "MIT)"])(
    "rejects unreviewed or malformed SPDX expression %s",
    (license) => {
      expect(isPermissiveLicense(license)).toBe(false);
    },
  );

  test("accepts the exact vendored Bun license for the pinned version", async () => {
    const text = await Bun.file(
      resolve(import.meta.dirname, `../../../scripts/licenses/bun-${BUN_LICENSE_PIN.version}-LICENSE.md`),
    ).text();

    expect(() => verifyBunLicensePin(BUN_LICENSE_PIN.version, text)).not.toThrow();
  });

  test("rejects Bun version drift without updating the vendored license", () => {
    expect(() => verifyBunLicensePin("9.9.9", "fixture")).toThrow("Bun license pin drift");
  });

  test("rejects modified vendored Bun license bytes", () => {
    expect(() => verifyBunLicensePin(BUN_LICENSE_PIN.version, "fixture")).toThrow("checksum mismatch");
  });

  test.each(["1.4.2", "1.4.2-debug"])("permits pinned Bun %s for native relinking", (version) => {
    expect(() => verifyBunCompilerVersion(version)).not.toThrow();
  });

  test("rejects a compiler whose runtime would not match the licensed version", () => {
    expect(() => verifyBunCompilerVersion("1.4.3")).toThrow(CompiledBinaryLicenseError);
  });
});
