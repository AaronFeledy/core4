import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AgentSocketKind,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  type MountPlan,
  PortablePath,
  SSH_AGENT_SOCKET_NAME,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { GPG_AGENT_PLAN_EXTENSION_KEY } from "../gpg-agent/intent.ts";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../ssh/intent.ts";
import type { AgentRelaySession } from "./session.ts";

const SshIntent = Schema.Struct({ mode: Schema.Literal("host", "sidecar") });
const GpgIntent = Schema.Struct({ forward: Schema.Literal(true) });
const Features = Schema.Struct({ featureIds: Schema.Array(Schema.String) });
const sshTarget = PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.ssh);
const gpgTarget = PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.gpg);
const gpgKeyringTarget = PortablePath.make("/run/lando/gpg-agent-keys");
const gpgHomeTarget = PortablePath.make("/run/lando/gnupg");
type OverlaySession = Pick<AgentRelaySession, "mount" | "kind" | "socketName">;

export const serviceHasSshAgentFeature = (service: ServicePlan): boolean => {
  if (Schema.is(SshIntent)(service.extensions[SSH_AGENT_PLAN_EXTENSION_KEY])) return true;
  const features = service.extensions["@lando/core/service-features"];
  return Schema.is(Features)(features) && features.featureIds.includes("lando.ssh-agent");
};
export const sshAgentEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasSshAgentFeature);

export const serviceHasGpgAgentFeature = (service: ServicePlan): boolean =>
  Schema.is(GpgIntent)(service.extensions[GPG_AGENT_PLAN_EXTENSION_KEY]);
export const gpgAgentEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasGpgAgentFeature);

const targetFor = (kind: AgentSocketKind) => (kind === "ssh" ? sshTarget : gpgTarget);

export const agentSocketOverlayFeature = (kind: AgentSocketKind, session: OverlaySession) => ({
  apply: (service: {
    readonly addEnv: (name: string, value: string) => void;
    readonly addMount: (mount: MountPlan) => void;
  }): void => {
    const target = targetFor(kind);
    switch (kind) {
      case "ssh":
        service.addEnv("SSH_AUTH_SOCK", `${target}/${SSH_AGENT_SOCKET_NAME}`);
        break;
      case "gpg":
        service.addEnv("GNUPGHOME", gpgHomeTarget);
        service.addEnv("LANDO_GPG_AGENT_SOCKET", `${target}/${GPG_AGENT_SOCKET_NAME}`);
        service.addEnv("LANDO_GPG_KEYRING", gpgKeyringTarget);
        break;
      default:
        kind satisfies never;
    }
    const mount = session.mount;
    switch (mount._tag) {
      case "bind-directory":
        service.addMount({
          type: "bind",
          source: mount.directory,
          target,
          readOnly: true,
          createHostPath: false,
          realization: "passthrough",
        });
        break;
      case "volume":
        service.addMount({
          type: "volume",
          source: mount.volume,
          target,
          readOnly: true,
          realization: "passthrough",
        });
        break;
      default:
        mount satisfies never;
        return;
    }
  },
});

const stripService = (kind: AgentSocketKind, service: ServicePlan): ServicePlan => {
  const target = targetFor(kind);
  const ownedEnvironment: Readonly<Record<string, string>> =
    kind === "ssh"
      ? { SSH_AUTH_SOCK: `${target}/${SSH_AGENT_SOCKET_NAME}` }
      : {
          GNUPGHOME: gpgHomeTarget,
          LANDO_GPG_AGENT_SOCKET: `${target}/${GPG_AGENT_SOCKET_NAME}`,
          LANDO_GPG_KEYRING: gpgKeyringTarget,
        };
  const ownedTargets: ReadonlyArray<string> =
    kind === "ssh" ? [target] : [target, gpgKeyringTarget, gpgHomeTarget];
  return {
    ...service,
    environment: Object.fromEntries(
      Object.entries(service.environment).filter(([name, value]) => ownedEnvironment[name] !== value),
    ),
    mounts: service.mounts.filter((mount) => !ownedTargets.includes(mount.target)),
  };
};

export const stripAgentSocketOverlay = (plan: AppPlan, kind: AgentSocketKind): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripService(kind, service)]),
  ),
});
export const stripSshAgentOverlay = (plan: AppPlan): AppPlan => stripAgentSocketOverlay(plan, "ssh");

const withAgentSocketOverlay = (
  plan: AppPlan,
  kind: AgentSocketKind,
  eligible: (service: ServicePlan) => boolean,
  session: OverlaySession,
  extraMounts: (service: {
    readonly addMount: (mount: MountPlan) => void;
  }) => void,
): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => {
      if (!eligible(service)) return [service.name, service];
      const clean = stripService(kind, service);
      const environment = { ...clean.environment };
      const mounts = [...clean.mounts];
      const addMount = (mount: MountPlan) => {
        mounts.push(mount);
      };
      agentSocketOverlayFeature(kind, session).apply({
        addEnv: (name, value) => {
          environment[name] = value;
        },
        addMount,
      });
      extraMounts({ addMount });
      return [service.name, { ...clean, environment, mounts }];
    }),
  ),
});

export const withSshAgentOverlay = (plan: AppPlan, session: OverlaySession): AppPlan =>
  withAgentSocketOverlay(plan, "ssh", serviceHasSshAgentFeature, session, () => undefined);

export const withGpgAgentOverlay = (plan: AppPlan, session: OverlaySession, keyringDir: string): AppPlan =>
  withAgentSocketOverlay(plan, "gpg", serviceHasGpgAgentFeature, session, ({ addMount }) => {
    addMount({
      type: "bind",
      source: keyringDir,
      target: gpgKeyringTarget,
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    });
    addMount({ type: "tmpfs", target: gpgHomeTarget, readOnly: false, realization: "passthrough" });
  });
