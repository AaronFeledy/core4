import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  RedactionService,
  makeRedactionService,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import { AppPlan } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Schema } from "effect";
import { registerAppOutputRedaction } from "../../src/services/app-output-redaction.ts";
import { sshAgentSessionPaths } from "../../src/subsystems/ssh-agent/session.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test.each(["ssh", "gpg"] as const)(
  "registers only trusted %s relay credentials without worker contact",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-output-relay-"));
    const paths = makeLandoPaths({ userDataRoot: root });
    const plan = Schema.decodeUnknownSync(AppPlan)({
      id: "relay-output",
      name: "relay-output",
      slug: "relay-output",
      root,
      provider: "test",
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: { resolvedAt: "2026-10-21T00:00:00Z", source: "test", runtime: 4 },
      extensions: {},
    });
    const recordPath = sshAgentSessionPaths(plan, paths.roots, kind).recordPath;
    const token = `${kind}-relay-private-control`;
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify({
        appId: plan.id,
        appRoot: plan.root,
        sessionId: "session",
        kind,
        protocolVersion: 2,
        configDigest: "digest",
        pid: 123,
        controlToken: token,
        controlPort: 12345,
        socketName: "agent.sock",
        mount: { _tag: "bind-directory", directory: root },
      }),
      { mode: 0o600 },
    );
    const redaction = makeRedactionService({
      id: "empty",
      list: Effect.succeed([]),
      get: () => Effect.die("No secret-store lookup expected"),
      has: () => Effect.succeed(false),
    });
    try {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          yield* registerAppOutputRedaction({ plan, provider: TestRuntimeProvider });
          return (yield* redaction.forProfile("secrets")).redactString(token);
        }).pipe(
          Effect.provideService(PathsService, paths),
          Effect.provideService(RedactionService, redaction),
          Effect.provide(PrivateFileAccessService.layer),
        ),
      );
      expect(output).toBe("[redacted]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
