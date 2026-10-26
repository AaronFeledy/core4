import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { uninstall } from "../../src/operations/uninstall.ts";
import { TerminableAgentRelayWorkerRecord } from "../../src/subsystems/ssh-agent/worker-protocol.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

test.each(["ssh", "gpg"] as const)("uninstall stops a live v1 %s relay", async (kind) => {
  // Given
  const roots = makeUninstallRoots("uninstall-relay-");
  const authenticated = join(roots.root, "authenticated");
  const identity = {
    appId: "demo",
    appRoot: AbsolutePath.make(roots.root),
    sessionId: "legacy-session",
    kind,
    protocolVersion: 1,
  };
  const token = "legacy-control-secret";
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { createServer } = require("node:net");
    const { writeFileSync } = require("node:fs");
    const identity = { ...${JSON.stringify(identity)}, pid: process.pid };
    const server = createServer(socket => {
      let text = "";
      socket.on("data", chunk => {
        text += chunk;
        if (!text.includes("\\n")) return;
        if (text.trim() !== ${JSON.stringify(token)}) {
          socket.destroy();
          return;
        }
        writeFileSync(${JSON.stringify(authenticated)}, "identified");
        socket.end(JSON.stringify(identity) + "\\n");
      });
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    const controlPort = Number(new TextDecoder().decode(ready.value).trim());
    expect(controlPort).toBeGreaterThan(0);
    const stateDir = makeLandoPaths({ userDataRoot: roots.userDataRoot }).agentRelayRunDir(
      kind,
      identity.appId,
      identity.appRoot,
    );
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const record = Schema.decodeUnknownSync(TerminableAgentRelayWorkerRecord)({
      ...identity,
      pid: child.pid,
      controlPort,
      controlToken: token,
      socketName: "agent.sock",
      mount: { _tag: "volume", volume: "relay" },
    });
    await writeFile(join(stateDir, "worker.json"), JSON.stringify(record), { mode: 0o600 });
    // When
    const result = await Effect.runPromise(
      uninstall(sandboxUninstallOptions(roots, { yes: true, purge: true })).pipe(
        Effect.provide(PrivateFileAccessService.layer),
      ),
    );
    // Then
    expect(result.failed).toBe(false);
    expect(existsSync(authenticated)).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
    expect(await child.exited).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(roots.root, { recursive: true, force: true });
  }
});
