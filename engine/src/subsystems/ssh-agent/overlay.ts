import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  type MountPlan,
  PortablePath,
  SSH_AGENT_SOCKET_NAME,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../ssh/intent.ts";
import type { AgentRelaySession } from "./session.ts";

const Intent = Schema.Struct({ mode: Schema.Literal("host", "sidecar") });
const Features = Schema.Struct({ featureIds: Schema.Array(Schema.String) });
const target = PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.ssh);
type OverlaySession = Pick<AgentRelaySession, "mount" | "kind" | "socketName">;

export const serviceHasSshAgentFeature = (service: ServicePlan): boolean => {
  if (Schema.is(Intent)(service.extensions[SSH_AGENT_PLAN_EXTENSION_KEY])) return true;
  const features = service.extensions["@lando/core/service-features"];
  return Schema.is(Features)(features) && features.featureIds.includes("lando.ssh-agent");
};
export const sshAgentEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasSshAgentFeature);

export const agentSocketOverlayFeature = (session: OverlaySession) => ({
  apply: (service: {
    readonly addEnv: (name: string, value: string) => void;
    readonly addMount: (mount: MountPlan) => void;
  }): void => {
    service.addEnv("SSH_AUTH_SOCK", `${target}/${SSH_AGENT_SOCKET_NAME}`);
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

const stripService = (service: ServicePlan): ServicePlan => ({
  ...service,
  environment: Object.fromEntries(
    Object.entries(service.environment).filter(
      ([name, value]) => name !== "SSH_AUTH_SOCK" || value !== `${target}/${SSH_AGENT_SOCKET_NAME}`,
    ),
  ),
  mounts: service.mounts.filter((mount) => mount.target !== target),
});

export const stripSshAgentOverlay = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripService(service)]),
  ),
});

export const withSshAgentOverlay = (plan: AppPlan, session: OverlaySession): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => {
      if (!serviceHasSshAgentFeature(service)) return [service.name, service];
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
      return [service.name, { ...clean, environment, mounts }];
    }),
  ),
});
