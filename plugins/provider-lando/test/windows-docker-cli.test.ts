import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either } from "effect";

import { prepareWindowsDockerCli } from "../src/windows-docker-cli.ts";

const directories: string[] = [];

const fixture = async () => {
  const binDir = await mkdtemp(join(tmpdir(), "lando-docker-compat-"));
  directories.push(binDir);
  await writeFile(join(binDir, ".runtime-installed-version"), "6.0.0\n");
  await writeFile(join(binDir, "podman.exe"), "owned-podman-binary");
  return binDir;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("prepareWindowsDockerCli", () => {
  test("creates a byte-identical provider-owned alias without changing host PATH", async () => {
    const binDir = await fixture();
    const inheritedPath = process.env.PATH;
    const alias = await Effect.runPromise(prepareWindowsDockerCli(binDir, "win32"));
    expect(alias).toBe(join(binDir, "docker-compat", "docker.exe"));
    expect(await readFile(alias, "utf8")).toBe("owned-podman-binary");
    expect(process.env.PATH).toBe(inheritedPath);
    expect(await Effect.runPromise(prepareWindowsDockerCli(binDir, "win32"))).toBe(alias);
  });

  test("concurrent preparation publishes only the same verified alias", async () => {
    const binDir = await fixture();
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(prepareWindowsDockerCli(binDir, "win32"))),
    );
    expect(new Set(paths).size).toBe(1);
    expect(await readFile(paths[0] as string, "utf8")).toBe("owned-podman-binary");
  });

  test("fails closed if the installed marker or source binary is missing", async () => {
    const binDir = await fixture();
    await rm(join(binDir, ".runtime-installed-version"));
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(binDir, "win32")))),
    ).toBe(true);
    await writeFile(join(binDir, ".runtime-installed-version"), "6.0.0\n");
    await rm(join(binDir, "podman.exe"));
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(binDir, "win32")))),
    ).toBe(true);
  });

  test("rejects a modified existing alias instead of replacing it", async () => {
    const binDir = await fixture();
    const alias = await Effect.runPromise(prepareWindowsDockerCli(binDir, "win32"));
    await writeFile(alias, "untrusted");
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(binDir, "win32")))),
    ).toBe(true);
    expect(await readFile(alias, "utf8")).toBe("untrusted");
  });

  test("rejects source drift after the alias was prepared", async () => {
    const binDir = await fixture();
    const alias = await Effect.runPromise(prepareWindowsDockerCli(binDir, "win32"));
    await writeFile(join(binDir, "podman.exe"), "changed-podman");
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(binDir, "win32")))),
    ).toBe(true);
    expect(await readFile(alias, "utf8")).toBe("owned-podman-binary");
  });

  test("rejects redirected source, alias, and alias directory", async () => {
    const sourceDir = await fixture();
    await rm(join(sourceDir, "podman.exe"));
    await symlink(join(sourceDir, ".runtime-installed-version"), join(sourceDir, "podman.exe"));
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(sourceDir, "win32")))),
    ).toBe(true);

    const aliasDir = await fixture();
    const alias = await Effect.runPromise(prepareWindowsDockerCli(aliasDir, "win32"));
    await rm(alias);
    await symlink(join(aliasDir, "podman.exe"), alias);
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(aliasDir, "win32")))),
    ).toBe(true);

    const redirectedDir = await fixture();
    const targetDir = await fixture();
    await mkdir(join(targetDir, "redirected"));
    await symlink(join(targetDir, "redirected"), join(redirectedDir, "docker-compat"));
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(redirectedDir, "win32")))),
    ).toBe(true);
  });

  test("does not prepare a Windows alias for another host family", async () => {
    const binDir = await fixture();
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(prepareWindowsDockerCli(binDir, "linux")))),
    ).toBe(true);
  });
});
