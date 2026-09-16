import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { phpDbClientBuildStepsForSources } from "../src/services/php-db-client-sources.ts";
import { phpMysqlArmSource } from "../src/services/php-mysql-arm.ts";

test.each(["8.0", "8.4", "9.7"])(
  "Given MySQL %s, when generating, then both architectures have verified sources",
  (version) => {
    // Given / When
    const [step] = phpDbClientBuildStepsForSources([{ family: "mysql", version }]);
    // Then
    expect(step?.user).toBe("root");
    expect(step?.buildKeyInputs).toMatchObject({
      dbClient: { source: { architectures: ["amd64", "arm64"] } },
    });
    const command = String(step?.command);
    expect(command).toContain(`https://repo.mysql.com/yum/mysql-${version}-community/el/9/aarch64/`);
    expect(command).toContain("sha256sum -c");
    expect(command.indexOf("sha256sum -c")).toBeLessThan(command.indexOf("bsdtar -xf"));
    expect(command).toContain("/usr/lib64/mysql");
    expect(command).toContain("ldconfig");
    expect(command).not.toMatch(/alien|rpm -i|mariadb/);
  },
);

test.each(["8.0", "8.4", "9.7"])(
  "Given MySQL %s, when generating amd64, then Oracle Bookworm APT is preserved",
  (version) => {
    const [step] = phpDbClientBuildStepsForSources([{ family: "mysql", version }]);
    const amd64 = String(step?.command).split(";; arm64)")[0];
    expect(amd64).toContain(`bookworm mysql-${version}${version === "8.0" ? "" : "-lts"}`);
    expect(amd64).toContain("gpg --show-keys --with-colons");
    expect(amd64).toContain("BCA43417C3B485DD128EC6D4B7B3B788A8D3785C");
    expect(amd64).toContain("apt-get install -y --no-install-recommends mysql-community-client");
    expect(amd64).not.toContain(".rpm");
  },
);

test.each(["arm64", "s390x"])(
  "Given %s with corrupt downloads, when running the generated shell, then extraction never starts",
  async (architecture) => {
    const root = await mkdtemp(join(tmpdir(), "lando-mysql-source-"));
    try {
      const trace = join(root, "trace");
      const scripts = {
        dpkg: `printf '%s' '${architecture}'`,
        "apt-get": "exit 0",
        php: `for name in mysql-community-common mysql-community-libs mysql-community-client-plugins mysql-community-client; do printf corrupt > "$work/$name-8.4.11-1.el9.aarch64.rpm"; done`,
        bsdtar: 'printf extract >> "$TRACE"',
        cp: "exit 99",
        ldconfig: "exit 99",
      };
      for (const [name, script] of Object.entries(scripts)) {
        const path = join(root, name);
        await Bun.write(path, `#!/bin/sh\n${script}\n`);
        await chmod(path, 0o700);
      }
      const [step] = phpDbClientBuildStepsForSources([{ family: "mysql", version: "8.4" }]);
      const fixtureHash = new Bun.CryptoHasher("sha256").update("corrupt").digest("hex");
      const command = phpMysqlArmSource("8.4")
        .artifacts.slice(0, 3)
        .reduce((shell, artifact) => shell.replaceAll(artifact.sha256, fixtureHash), String(step?.command));
      const child = Bun.spawn(["/bin/sh", "-c", command], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TRACE: trace, TMPDIR: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit).not.toBe(0);
      expect(await Bun.file(trace).exists()).toBe(false);
      expect(stdout + stderr).toContain(
        architecture === "arm64" ? "FAILED" : "Unsupported architecture s390x",
      );
      if (architecture === "arm64") expect(stdout.match(/: OK/g)).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Given pinned ARM packages, when projecting build identity, then every URL and digest is retained", () => {
  const arm = phpMysqlArmSource("8.4");
  const [step] = phpDbClientBuildStepsForSources([{ family: "mysql", version: "8.4" }]);
  expect(arm.artifacts.map((artifact) => artifact.package)).toEqual([
    "mysql-community-common",
    "mysql-community-libs",
    "mysql-community-client-plugins",
    "mysql-community-client",
  ]);
  expect(step?.buildKeyInputs).toMatchObject({
    dbClient: {
      source: {
        artifacts: {
          arm64: {
            architecture: "arm64",
            kind: "rpm-payload",
            version: "8.4.11",
            artifacts: arm.artifacts,
          },
        },
      },
    },
  });
  expect(arm.command).toContain('cp -a "$work/payload/usr/lib64/mysql/." /usr/lib64/mysql/');
});
