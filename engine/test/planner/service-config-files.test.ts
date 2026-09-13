import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either } from "effect";

import { resolveServiceConfigSources } from "../../src/planner/service-config-files.ts";

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("service config file sources", () => {
  let root: string;
  let appRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-config-files-"));
    appRoot = join(root, "app");
    await mkdir(join(appRoot, "conf", "nested"), { recursive: true });
    await writeFile(join(appRoot, "server.cnf"), new Uint8Array([0, 255, 10]));
    await writeFile(join(appRoot, "conf", "z.xml"), "last");
    await writeFile(join(appRoot, "conf", "nested", "a.xml"), "first");
    await writeFile(join(root, "outside.cnf"), "outside");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const resolveConfig = (config: Parameters<typeof resolveServiceConfigSources>[0]["config"]) =>
    resolveServiceConfigSources({ appRoot, serviceName: "database", config });

  test.each([undefined, {}])("returns no sources when config is %j", async (config) => {
    // Given an app without file-backed config; when resolving it.
    const result = await Effect.runPromise(resolveConfig(config));
    // Then no sources are produced.
    expect(result).toEqual([]);
  });

  test("hashes raw bytes when server is a regular file", async () => {
    // Given the binary server fixture; when resolving it.
    const result = await Effect.runPromise(resolveConfig({ server: "server.cnf" }));
    // Then the authored path and canonical source accompany the byte digest.
    expect(result).toEqual([
      {
        key: "server",
        authored: "server.cnf",
        source: await realpath(join(appRoot, "server.cnf")),
        digest: sha256(new Uint8Array([0, 255, 10])),
      },
    ]);
  });

  test("hashes sorted POSIX paths when dir contains nested files", async () => {
    // Given nested files created in reverse lexical order; when resolving them.
    const result = await Effect.runPromise(resolveConfig({ dir: "conf" }));
    // Then identity follows the specified file-list encoding.
    expect(result).toEqual([
      {
        key: "dir",
        authored: "conf",
        source: await realpath(join(appRoot, "conf")),
        digest: sha256(`nested/a.xml\0${sha256("first")}\nz.xml\0${sha256("last")}\n`),
      },
    ]);
  });

  test("orders server before dir when both are authored", async () => {
    // Given reversed config keys; when resolving both.
    const result = await Effect.runPromise(resolveConfig({ dir: "conf", server: "server.cnf" }));
    // Then key order is deterministic.
    expect(result.map(({ key }) => key)).toEqual(["server", "dir"]);
  });

  test.each([
    { key: "server", authored: "../outside.cnf" },
    { key: "server", authored: "~/x.cnf" },
    { key: "server", authored: "conf" },
    { key: "dir", authored: "server.cnf" },
    { key: "server", authored: "missing.cnf" },
    { key: "dir", authored: "missing" },
    { key: "server", authored: "" },
    { key: "dir", authored: "" },
  ] as const)("rejects $key source $authored", async ({ key, authored }) => {
    // Given an invalid authored source; when resolving it.
    const result = await Effect.runPromise(Effect.either(resolveConfig({ [key]: authored })));
    // Then validation identifies the exact config field.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileValidationError");
      expect(result.left.issues).toContain(`services.database.config.${key}`);
      expect(result.left.file).toBe(`${appRoot}/.lando.yml`);
      expect(result.left.message).toContain(`services.database.config.${key}`);
    }
  });

  test("rejects an absolute authored path even when inside the app", async () => {
    // Given an absolute path to an existing file; when resolving it.
    const result = await Effect.runPromise(
      Effect.either(resolveConfig({ server: join(appRoot, "server.cnf") })),
    );
    // Then callers receive the tagged validation failure.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileValidationError");
      expect(result.left.issues).toContain("services.database.config.server");
    }
  });

  test.each(["outside", "dangling", "cycle"] as const)("rejects a %s symlink inside dir", async (kind) => {
    // Given an escaping, dangling, or cyclic link inside the source tree.
    const targets = {
      outside: join(root, "outside.cnf"),
      dangling: join(appRoot, "absent"),
      cycle: join(appRoot, "conf"),
    };
    await symlink(
      targets[kind],
      join(appRoot, "conf", "nested", "bad-link"),
      kind === "cycle" ? "dir" : "file",
    );
    // When resolving the directory.
    const result = await Effect.runPromise(Effect.either(resolveConfig({ dir: "conf" })));
    // Then the failure names the offending relative entry.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileValidationError");
      expect(result.left.issues).toContain("services.database.config.dir");
      expect(result.left.message).toContain("nested/bad-link");
    }
  });

  test("follows contained symlinks when their targets are regular files", async () => {
    // Given a safe link into another part of the app.
    await symlink(join(appRoot, "server.cnf"), join(appRoot, "conf", "linked.cnf"), "file");
    // When resolving the tree.
    const result = await Effect.runPromise(resolveConfig({ dir: "conf" }));
    // Then the link's relative name contributes its target bytes.
    expect(result[0]?.digest).toBe(
      sha256(
        `linked.cnf\0${sha256(new Uint8Array([0, 255, 10]))}\nnested/a.xml\0${sha256("first")}\nz.xml\0${sha256("last")}\n`,
      ),
    );
  });

  test("keeps identity stable when sources have not changed", async () => {
    // Given an existing resolution.
    const config = { server: "server.cnf", dir: "conf" };
    const before = await Effect.runPromise(resolveConfig(config));
    // When resolving the same inputs again.
    const after = await Effect.runPromise(resolveConfig(config));
    // Then identities are identical.
    expect(after).toEqual(before);
  });

  test.each(["server", "dir"] as const)("changes %s identity when bytes change", async (key) => {
    // Given the original digest and changed source bytes.
    const config = { [key]: key === "server" ? "server.cnf" : "conf" };
    const before = await Effect.runPromise(resolveConfig(config));
    await writeFile(join(appRoot, key === "server" ? "server.cnf" : "conf/nested/a.xml"), "changed");
    // When resolving the modified source.
    const after = await Effect.runPromise(resolveConfig(config));
    // Then its identity changes.
    expect(after[0]?.digest).not.toBe(before[0]?.digest);
  });

  test.each(["rename", "add", "remove"] as const)("changes dir identity after file %s", async (change) => {
    // Given the original directory digest and a structural change.
    const before = await Effect.runPromise(resolveConfig({ dir: "conf" }));
    const mutations = {
      rename: () => rename(join(appRoot, "conf/z.xml"), join(appRoot, "conf/renamed.xml")),
      add: () => writeFile(join(appRoot, "conf/added.xml"), "added"),
      remove: () => rm(join(appRoot, "conf/z.xml")),
    };
    await mutations[change]();
    // When resolving the modified tree.
    const after = await Effect.runPromise(resolveConfig({ dir: "conf" }));
    // Then file names participate in the identity.
    expect(after[0]?.digest).not.toBe(before[0]?.digest);
  });
});
