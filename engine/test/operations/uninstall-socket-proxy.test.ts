import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SOCKET_PROXY_UNIT_MARKER,
  executeSocketProxyHelperStep,
} from "../../src/operations/uninstall-socket-proxy.ts";
import { makeUninstallRoots } from "./uninstall-support.ts";

describe("executeSocketProxyHelperStep elevation", () => {
  test("elevated command includes rm of owned unit and polkit paths", async () => {
    // Given: owned marked unit and polkit files in injectable sandbox dirs.
    const roots = makeUninstallRoots("lando-uninstall-socket-rm-");
    mkdirSync(roots.socketProxyUnitDir, { recursive: true });
    const unitPaths = [
      join(roots.socketProxyUnitDir, "lando-proxy-http.socket"),
      join(roots.socketProxyUnitDir, "lando-proxy-http.service"),
      join(roots.socketProxyUnitDir, "lando-proxy-https.socket"),
      join(roots.socketProxyUnitDir, "lando-proxy-https.service"),
    ];
    for (const path of unitPaths) {
      writeFileSync(path, `${SOCKET_PROXY_UNIT_MARKER}\n[Unit]\n`);
    }
    writeFileSync(roots.socketProxyPolkitPath, `${SOCKET_PROXY_UNIT_MARKER}\n`);
    const elevated: Array<ReadonlyArray<string>> = [];

    // When: uninstall executes the helper step with an elevate spy.
    await executeSocketProxyHelperStep({
      paths: { unitPaths, polkitPath: roots.socketProxyPolkitPath },
      io: {
        exists: () => true,
        readText: () => `${SOCKET_PROXY_UNIT_MARKER}\n`,
      },
      remove: async () => undefined,
      elevate: async (command) => {
        elevated.push(command);
        return { exitCode: 0 };
      },
    });

    // Then: one elevated script stops units, rms owned paths, and reloads systemd.
    const script = elevated.map((command) => command.join(" ")).join("\n");
    expect(script).toMatch(/\brm\b/);
    for (const path of unitPaths) {
      expect(script).toContain(path);
    }
    expect(script).toContain(roots.socketProxyPolkitPath);
    expect(script).toContain("systemctl");
  });

  test("returns failed when the elevated cleanup script exits nonzero", async () => {
    const roots = makeUninstallRoots("lando-uninstall-socket-fail-");
    const unitPaths = [join(roots.socketProxyUnitDir, "lando-proxy-http.socket")];
    const outcome = await executeSocketProxyHelperStep({
      paths: { unitPaths, polkitPath: roots.socketProxyPolkitPath },
      io: {
        exists: () => true,
        readText: () => `${SOCKET_PROXY_UNIT_MARKER}\n`,
      },
      remove: async () => undefined,
      elevate: async () => ({ exitCode: 1, stderr: "denied" }),
    });
    expect(outcome).toBe("failed");
  });
});
