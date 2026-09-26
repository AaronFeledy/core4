import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { AbsolutePath, GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, SshService } from "@lando/sdk/services";
import { makeTestSshService } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "../../src/cli/commands/doctor-subsystems.ts";

test.each([true, false])(
  "doctor probes a real SSH protocol socket with sidecar=%s without exposing identities",
  async (sidecar) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "doctor-agent-"));
    const path = join(root, "agent.sock");
    const key = Buffer.from("public-key-blob-must-not-be-reported");
    const comment = Buffer.from("private-user@example.test");
    const frame = Buffer.alloc(17 + key.length + comment.length);
    frame.writeUInt32BE(frame.length - 4, 0);
    frame[4] = 12;
    frame.writeUInt32BE(1, 5);
    frame.writeUInt32BE(key.length, 9);
    key.copy(frame, 13);
    frame.writeUInt32BE(comment.length, 13 + key.length);
    comment.copy(frame, 17 + key.length);
    const requests: Buffer[] = [];
    const server = createServer((socket) =>
      socket.once("data", (request) => {
        requests.push(request);
        socket.end(frame);
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });
      const config = Schema.decodeUnknownSync(GlobalConfig)({ sshAgent: { sidecar, socket: path } });
      // When
      const result = await Effect.runPromise(
        subsystemDoctor({
          sshAgent: {
            capabilities: { agentSocket: { delivery: "bind-directory" } },
            env: {},
          },
        }).pipe(
          Effect.provideService(ConfigService, {
            load: Effect.succeed(config),
            get: (name) => Effect.succeed(config[name]),
          }),
          Effect.provideService(SshService, {
            ...makeTestSshService(),
            id: "sidecar",
            getAgentSocket: (appId) => Effect.succeed({ appId, socketPath: AbsolutePath.make(path) }),
          }),
          Effect.provide(FileSystemLive),
          Effect.provide(DefaultSubsystemDoctorLayer),
        ),
      );
      // Then
      const check = result.checks.find((entry) => entry.name === "ssh");
      expect(check).toMatchObject({
        status: "pass",
        details: {
          mode: sidecar ? "sidecar" : "host",
          upstream: { source: sidecar ? "sidecar" : "explicit", reachable: true, identities: 1 },
        },
      });
      expect(requests).toEqual([Buffer.from([0, 0, 0, 1, 11])]);
      expect(JSON.stringify(result)).not.toContain(key.toString());
      expect(JSON.stringify(result)).not.toContain(comment.toString());
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
