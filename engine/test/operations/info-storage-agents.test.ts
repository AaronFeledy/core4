import { expect, test } from "bun:test";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import { AbsolutePath, type AppPlan, PortablePath, type ServicePlan } from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { Effect } from "effect";
import { withGpgAgentOverlay } from "../../src/subsystems/gpg-agent/overlay.ts";
import { layer as sanitizerLayer } from "../../src/subsystems/host-proxy/plan-sanitizer-live.ts";
import { withSshAgentOverlay } from "../../src/subsystems/ssh-agent/overlay.ts";
import { plan, runInfo, service } from "./info-storage-fixture.ts";

const targets = [
  "/run/lando/ssh-agent",
  "/etc/ssh/ssh_known_hosts",
  "/run/lando/gpg-agent",
  "/run/lando/gpg-agent-keys",
] as const;
const eligible: ServicePlan = {
  ...service,
  extensions: {
    "@lando/core/ssh-agent": { mode: "host" },
    "@lando/core/gpg-agent": { forward: true },
  },
};
const evidenceCases = [
  { name: "forwarding off", selected: service, labels: {} },
  { name: "eligible but not injected", selected: eligible, labels: {} },
  {
    name: "nonmatching environment",
    selected: {
      ...eligible,
      environment: {
        SSH_AUTH_SOCK: "/custom/ssh",
        LANDO_GPG_AGENT_SOCKET: "/custom/gpg",
        LANDO_GPG_KEYRING: "/custom/keys",
      },
    },
    labels: {},
  },
  {
    name: "nonmatching markers",
    selected: service,
    labels: { "dev.lando.ssh-agent-overlay": "false", "dev.lando.gpg-agent-overlay": "arbitrary" },
  },
  { name: "relay-only marker", selected: service, labels: { "dev.lando.agent-session": "session" } },
  { name: "host-proxy only", selected: service, labels: { "dev.lando.host-proxy-session": "session" } },
] as const;

for (const target of targets) {
  test.each([...evidenceCases])(
    `retains authored mounts at ${target} when $name`,
    async ({ selected, labels }) => {
      // Given
      const mount = { type: "bind" as const, source: "/user/files", target, readOnly: true };
      const authored: ServicePlan = {
        ...selected,
        mounts: [{ ...mount, target: PortablePath.make(target), realization: "passthrough" }],
      };
      // When
      const { row } = await runInfo(authored, { status: "present", mounts: [mount] }, labels);
      // Then
      expect(row?.mounts).toEqual([
        { ...mount, origin: "planned", observation: "present", lifetime: "retained" },
      ]);
    },
  );

  test.each([...evidenceCases])(
    `retains declared stores at ${target} when $name`,
    async ({ selected, labels }) => {
      // Given
      const mount = { type: "volume" as const, source: "user-data", target, readOnly: false };
      const authored: ServicePlan = {
        ...selected,
        mounts: [{ type: "volume", store: mount.source, target: PortablePath.make(target), readOnly: false }],
      };
      // When
      const { row } = await runInfo(authored, { status: "present", mounts: [mount] }, labels);
      // Then
      expect(row?.mounts).toEqual([
        { ...mount, origin: "planned", observation: "present", lifetime: "retained" },
      ]);
    },
  );

  test.each([...evidenceCases])(
    `retains runtime-only volumes at ${target} when $name`,
    async ({ selected, labels }) => {
      // Given
      const mount = { type: "volume" as const, source: "runtime-data", target };
      // When
      const { row } = await runInfo(selected, { status: "present", mounts: [mount] }, labels);
      // Then
      expect(row?.mounts).toEqual([
        { ...mount, origin: "runtime", observation: "present", lifetime: "unknown" },
      ]);
    },
  );
}

const overlays = {
  ssh: (input: AppPlan) =>
    withSshAgentOverlay(
      input,
      {
        kind: "ssh",
        socketName: "agent.sock",
        mount: { _tag: "volume", volume: "ssh-relay" },
      },
      { knownHostsFile: "/home/user/.ssh/known_hosts" },
    ),
  gpg: (input: AppPlan) =>
    withGpgAgentOverlay(
      input,
      {
        kind: "gpg",
        socketName: "S.gpg-agent",
        mount: { _tag: "bind-directory", directory: AbsolutePath.make("/relay/gpg") },
      },
      "/relay/keyring",
    ),
} as const;

for (const kind of ["ssh", "gpg"] as const) {
  const input = { ...plan, services: { [eligible.name]: eligible } };
  const applied = kind === "ssh" ? Effect.runSync(overlays.ssh(input)) : Effect.runSync(overlays.gpg(input));
  const selected = applied.services[eligible.name];
  if (selected === undefined) throw new TypeError("Missing applied fixture service");
  const observed = selected.mounts.map((mount) => ({
    type: mount.type,
    ...(mount.type === "bind"
      ? { source: mount.source }
      : mount.type === "volume"
        ? { source: mount.store }
        : {}),
    target: mount.target,
    readOnly: mount.readOnly,
  }));
  const otherTargets = targets.filter((target) => !observed.some((mount) => mount.target === target));
  const userMounts = otherTargets.map((target) => ({ type: "volume" as const, source: "user-data", target }));

  test(`hides only injected ${kind} mounts when the real overlay is present`, async () => {
    // Given: only one agent is injected, despite eligibility for both.
    const mounts = { status: "present" as const, mounts: [...observed, ...userMounts] };
    // When
    const { row } = await runInfo(selected, mounts);
    // Then
    expect(row?.mounts).toEqual(
      userMounts.map((mount) => ({
        ...mount,
        origin: "runtime",
        observation: "present",
        lifetime: "unknown",
      })),
    );
  });

  test.each([true, false])(`projects sanitized ${kind} mounts with inspected marker = %s`, async (marked) => {
    // Given: use the actual persistence sanitizer, not a hand-stripped fixture.
    const sanitized = Effect.runSync(
      Effect.gen(function* () {
        return (yield* AppPlanSanitizer).sanitizeForPersistence(applied);
      }).pipe(Effect.provide(sanitizerLayer)),
    );
    const persisted = sanitized.services[eligible.name];
    if (persisted === undefined) throw new TypeError("Missing persisted fixture service");
    const labels = marked ? commonContainerLabels(applied, selected) : {};
    const mounts = { status: "present" as const, mounts: [...observed, ...userMounts] };
    // When
    const { row, calls } = await runInfo(persisted, mounts, labels);
    // Then
    expect(row?.mounts).toEqual(
      (marked ? userMounts : [...observed, ...userMounts]).map((mount) => ({
        ...mount,
        origin: "runtime",
        observation: "present",
        lifetime: mount.type === "bind" ? "retained" : "unknown",
      })),
    );
    expect(calls).toEqual(["select", "inspect:web"]);
  });
}
