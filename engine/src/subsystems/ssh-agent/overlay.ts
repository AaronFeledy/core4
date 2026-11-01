import { SshAgentTransportError } from "@lando/sdk/errors";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  type MountPlan,
  PortablePath,
  SSH_AGENT_SOCKET_NAME,
  type ServicePlan,
  duplicateMountTarget,
  orderMounts,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "../ssh/intent.ts";
import { type AgentRelaySession, agentSocketMountPlan } from "./session.ts";

const Intent = Schema.Struct({ mode: Schema.Literals(["host", "sidecar"]) });
const Features = Schema.Struct({ featureIds: Schema.Array(Schema.String) });
const target = PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.ssh);
const knownHostsTarget = PortablePath.make("/etc/ssh/ssh_known_hosts");
const ownedTargets: readonly string[] = [target, knownHostsTarget];
type OverlaySession = Pick<AgentRelaySession, "mount" | "kind" | "socketName">;

export const serviceHasSshAgentFeature = (service: ServicePlan): boolean => {
  if (Schema.is(Intent)(service.extensions[SSH_AGENT_PLAN_EXTENSION_KEY])) return true;
  const features = service.extensions["@lando/core/service-features"];
  return Schema.is(Features)(features) && features.featureIds.includes("lando.ssh-agent");
};
export const sshAgentEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasSshAgentFeature);

export const validateSshAgentOverlay = (plan: AppPlan) =>
  Effect.forEach(
    sshAgentEligibleServices(plan),
    (service) => {
      const duplicate =
        duplicateMountTarget(orderMounts(service.mounts)) ??
        service.mounts.find((mount) => mount.target === target)?.target;
      return duplicate === undefined
        ? Effect.void
        : Effect.fail(
            new SshAgentTransportError({
              message: `SSH agent mount target ${duplicate} collides with a planned mount on ${service.name}.`,
              stage: "bridge",
              remediation: "Remove the conflicting mount or disable the ssh-agent feature for this service.",
            }),
          );
    },
    { discard: true },
  );

export const agentSocketOverlayFeature = (session: OverlaySession) => ({
  apply: (service: {
    readonly addEnv: (name: string, value: string) => void;
    readonly addMount: (mount: MountPlan) => void;
  }): void => {
    service.addEnv("SSH_AUTH_SOCK", `${target}/${SSH_AGENT_SOCKET_NAME}`);
    service.addMount(agentSocketMountPlan(session.mount, target));
  },
});

const stripService = (service: ServicePlan): ServicePlan => ({
  ...service,
  environment: Object.fromEntries(
    Object.entries(service.environment).filter(
      ([name, value]) => name !== "SSH_AUTH_SOCK" || value !== `${target}/${SSH_AGENT_SOCKET_NAME}`,
    ),
  ),
  mounts: service.mounts.filter(
    (mount) =>
      !ownedTargets.includes(mount.target) || (mount.origin !== undefined && mount.origin !== "integration"),
  ),
});

export const stripSshAgentOverlay = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripService(service)]),
  ),
});

export const withSshAgentOverlay = Effect.fnUntraced(function* (
  plan: AppPlan,
  session: OverlaySession,
  options?: { readonly knownHostsFile?: string; readonly knownHostsSourceIdentity?: string },
): Effect.fn.Return<AppPlan, SshAgentTransportError> {
  const services = { ...plan.services };
  for (const service of Object.values(plan.services)) {
    if (!serviceHasSshAgentFeature(service)) continue;
    const environment = { ...service.environment };
    const mounts: MountPlan[] = [...service.mounts];
    agentSocketOverlayFeature(session).apply({
      addEnv: (name, value) => {
        environment[name] = value;
      },
      addMount: (mount) => {
        mounts.push(mount);
      },
    });
    // Existing ownership wins, including directories where a nested bind could create a host file.
    const knownHostsOwned = service.mounts.some((mount) => {
      const mountTarget = mount.target.replace(/\/+$/, "");
      return knownHostsTarget === mountTarget || knownHostsTarget.startsWith(`${mountTarget}/`);
    });
    if (options?.knownHostsFile !== undefined && !knownHostsOwned) {
      mounts.push({
        type: "bind",
        origin: "integration",
        source: options.knownHostsFile,
        ...(options.knownHostsSourceIdentity === undefined
          ? {}
          : { sourceIdentity: options.knownHostsSourceIdentity }),
        target: knownHostsTarget,
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
      });
    }
    const ordered = orderMounts(mounts);
    const duplicate = duplicateMountTarget(ordered);
    if (duplicate !== undefined) {
      return yield* Effect.fail(
        new SshAgentTransportError({
          message: `SSH agent mount target ${duplicate} collides with a planned mount on ${service.name}.`,
          stage: "bridge",
          remediation: "Remove the conflicting mount or disable the ssh-agent feature for this service.",
        }),
      );
    }
    services[service.name] = { ...service, environment, mounts: ordered };
  }
  return { ...plan, services };
});
