import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { sudoSpawnForPrivilege } from "../../src/services/privilege.ts";

describe("PrivilegeService", () => {
  test("uses sudo -A with SUDO_ASKPASS when an askpass helper exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-askpass-"));
    const askpass = join(root, "sudo-askpass.sh");
    await writeFile(askpass, "#!/bin/sh\nprintf '%s\\n' password\n", "utf-8");
    await chmod(askpass, 0o700);

    const spawn = await sudoSpawnForPrivilege(["sh", "-c", "true"], {
      env: { SUDO_ASKPASS: askpass },
      platform: "linux",
    });

    expect(spawn.cmd).toBe("sudo");
    expect(spawn.args).toEqual(["-A", "sh", "-c", "true"]);
    expect(spawn.env).toEqual({ SUDO_ASKPASS: askpass });
  });

  test("uses sudo -n on Linux when no askpass helper exists", async () => {
    const spawn = await sudoSpawnForPrivilege(["sh", "-c", "true"], {
      env: { SUDO_ASKPASS: "/tmp/does-not-exist" },
      platform: "linux",
    });

    expect(spawn.cmd).toBe("sudo");
    expect(spawn.args).toEqual(["-n", "sh", "-c", "true"]);
    expect(spawn.env).toEqual({});
  });
});
