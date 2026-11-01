import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATE_CONFIG_LABEL } from "@lando/container-runtime/create-fingerprint";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import { PortablePath } from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { Effect } from "effect";
import { withStartedSshAgent } from "../../src/operations/start-ssh-agent.ts";
import { layer as sanitizerLayer } from "../../src/subsystems/host-proxy/plan-sanitizer-live.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

for (const mode of ["host", "sidecar"] as const) {
  for (const present of [true, false]) {
    test(`${mode} start ${present ? "shares" : "omits"} host known hosts without persisting the overlay`, async () => {
      const home = await mkdtemp(join(tmpdir(), "lando-start-known-hosts-"));
      try {
        const knownHostsFile = join(home, ".ssh", "known_hosts");
        if (present) {
          await mkdir(join(home, ".ssh"));
          await writeFile(knownHostsFile, "host ssh-ed25519 fixture");
        }
        const input = {
          ...plan,
          services: { [web.name]: { ...web, extensions: { "@lando/core/ssh-agent": { mode } } } },
        };
        const harness = makeHarness({ plannedApp: input });
        const result = await Effect.runPromise(
          withStartedSshAgent(
            input,
            { kind: "user", id: plan.id, root: plan.root },
            {},
            { mode },
            {
              home,
              startSession: () =>
                Effect.succeed({
                  appId: plan.id,
                  sessionId: "test",
                  kind: "ssh",
                  socketName: "agent.sock",
                  mount: { _tag: "volume", volume: "agent" },
                  close: () => Promise.resolve(),
                  closed: Promise.resolve(),
                }),
              use: Effect.succeed,
            },
          ).pipe(Effect.provide(harness.layer)),
        );
        expect(
          result.services[web.name]?.mounts.filter((mount) => mount.target === "/etc/ssh/ssh_known_hosts"),
        ).toEqual(
          present
            ? [
                {
                  type: "bind",
                  origin: "integration",
                  source: knownHostsFile,
                  target: PortablePath.make("/etc/ssh/ssh_known_hosts"),
                  readOnly: true,
                  createHostPath: false,
                  realization: "passthrough",
                },
              ]
            : [],
        );
        const persisted = Effect.runSync(
          Effect.gen(function* () {
            return (yield* AppPlanSanitizer).sanitizeForPersistence(result);
          }).pipe(Effect.provide(sanitizerLayer)),
        );
        expect(persisted).toEqual(input);
        const appliedService = result.services[web.name];
        const plannedService = input.services[web.name];
        if (appliedService === undefined || plannedService === undefined)
          throw new TypeError("Missing service");
        const appliedFingerprint = commonContainerLabels(result, appliedService)[CREATE_CONFIG_LABEL];
        const plannedFingerprint = commonContainerLabels(input, plannedService)[CREATE_CONFIG_LABEL];
        expect(appliedFingerprint === plannedFingerprint).toBe(!present);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
}

test("strips stale SSH mounts without discovering known hosts when no session starts", async () => {
  // Given
  const input = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        extensions: { "@lando/core/ssh-agent": { mode: "host" } },
        environment: { ...web.environment, SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock" },
        mounts: [
          ...web.mounts,
          {
            type: "bind" as const,
            origin: "integration" as const,
            source: "/stale/known_hosts",
            target: PortablePath.make("/etc/ssh/ssh_known_hosts"),
            readOnly: true,
            createHostPath: false,
            realization: "passthrough" as const,
          },
        ],
      },
    },
  };
  const harness = makeHarness({ plannedApp: input });

  // When
  const result = await Effect.runPromise(
    withStartedSshAgent(
      input,
      { kind: "user", id: plan.id, root: plan.root },
      {},
      { mode: "host" },
      {
        get home(): string {
          throw new Error("Absent sessions must not discover known hosts");
        },
        startSession: () => Effect.succeed(undefined),
        use: Effect.succeed,
      },
    ).pipe(Effect.provide(harness.layer)),
  );

  // Then
  expect(result.services[web.name]).toEqual({
    ...web,
    extensions: { "@lando/core/ssh-agent": { mode: "host" } },
  });
});
