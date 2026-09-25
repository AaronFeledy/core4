import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  type MountPlan,
  PortablePath,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import type { AgentRelaySession } from "../ssh-agent/session.ts";
import { GPG_AGENT_PLAN_EXTENSION_KEY } from "./intent.ts";

const Intent = Schema.Struct({ forward: Schema.Literal(true) });
const target = PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.gpg);
const keyringTarget = PortablePath.make("/run/lando/gpg-agent-keys");
const homeTarget = PortablePath.make("/run/lando/gnupg");
type OverlaySession = Pick<AgentRelaySession, "mount" | "kind" | "socketName">;

export const serviceHasGpgAgentFeature = (service: ServicePlan): boolean =>
  Schema.is(Intent)(service.extensions[GPG_AGENT_PLAN_EXTENSION_KEY]);
export const gpgAgentEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasGpgAgentFeature);

const agentSocketName = `${target}/${GPG_AGENT_SOCKET_NAME}`;
const ownedEnvironmentNames = new Set(["GNUPGHOME", "LANDO_GPG_AGENT_SOCKET", "LANDO_GPG_KEYRING"]);
const ownedEnvironmentValue = (name: string): string | undefined => {
  switch (name) {
    case "GNUPGHOME":
      return homeTarget;
    case "LANDO_GPG_AGENT_SOCKET":
      return agentSocketName;
    case "LANDO_GPG_KEYRING":
      return keyringTarget;
    default:
      return undefined;
  }
};

export const agentSocketOverlayFeature = (session: OverlaySession) => ({
  apply: (service: {
    readonly addEnv: (name: string, value: string) => void;
    readonly addMount: (mount: MountPlan) => void;
  }): void => {
    service.addEnv("GNUPGHOME", homeTarget);
    service.addEnv("LANDO_GPG_AGENT_SOCKET", agentSocketName);
    service.addEnv("LANDO_GPG_KEYRING", keyringTarget);
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
        return;
      case "volume":
        service.addMount({
          type: "volume",
          source: mount.volume,
          target,
          readOnly: true,
          realization: "passthrough",
        });
        return;
      default:
        mount satisfies never;
        return;
    }
  },
});

const stripService = (service: ServicePlan): ServicePlan => {
  const ownedTargets: ReadonlyArray<string> = [target, keyringTarget, homeTarget];
  return {
    ...service,
    environment: Object.fromEntries(
      Object.entries(service.environment).filter(
        ([name, value]) => !ownedEnvironmentNames.has(name) || ownedEnvironmentValue(name) !== value,
      ),
    ),
    mounts: service.mounts.filter((mount) => !ownedTargets.includes(mount.target)),
  };
};

export const stripGpgAgentOverlay = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripService(service)]),
  ),
});

export const withGpgAgentOverlay = (plan: AppPlan, session: OverlaySession, keyringDir: string): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => {
      if (!serviceHasGpgAgentFeature(service)) return [service.name, service];
      const clean = stripService(service);
      const environment = { ...clean.environment };
      const mounts = [...clean.mounts];
      agentSocketOverlayFeature(session).apply({
        addEnv: (name, value) => {
          environment[name] = value;
        },
        addMount: (mount) => {
          mounts.push(mount);
        },
      });
      mounts.push({
        type: "bind",
        source: keyringDir,
        target: keyringTarget,
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
      });
      mounts.push({ type: "tmpfs", target: homeTarget, readOnly: false, realization: "passthrough" });
      return [service.name, { ...clean, environment, mounts }];
    }),
  ),
});
