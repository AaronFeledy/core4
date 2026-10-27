import { GpgAgentTransportError } from "@lando/sdk/errors";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  type MountPlan,
  PortablePath,
  type ServicePlan,
  duplicateMountTarget,
  orderMounts,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { type AgentRelaySession, agentSocketMountPlan } from "../ssh-agent/session.ts";
import { GPG_AGENT_PLAN_EXTENSION_KEY } from "./intent.ts";

const Intent = Schema.Struct({ forward: Schema.Literal(true) });
const target = PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.gpg);
const keyringTarget = PortablePath.make("/run/lando/gpg-agent-keys");
// A world-writable /tmp lets any service user create a private (0700) home; per-start preparation fills it.
const homeTarget = PortablePath.make("/tmp/lando-gnupg");
type OverlaySession = Pick<AgentRelaySession, "mount" | "kind" | "socketName">;
const ownedTargets: ReadonlyArray<string> = [target, keyringTarget];

export const serviceHasGpgAgentFeature = (service: ServicePlan): boolean =>
  Schema.is(Intent)(service.extensions[GPG_AGENT_PLAN_EXTENSION_KEY]);
export const gpgAgentEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasGpgAgentFeature);

const agentSocketName = `${target}/${GPG_AGENT_SOCKET_NAME}`;
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
    service.addMount(agentSocketMountPlan(session.mount, target));
  },
});

const stripService = (service: ServicePlan): ServicePlan => ({
  ...service,
  environment: Object.fromEntries(
    Object.entries(service.environment).filter(([name, value]) => ownedEnvironmentValue(name) !== value),
  ),
  mounts: service.mounts.filter(
    (mount) =>
      !ownedTargets.includes(mount.target) || (mount.origin !== undefined && mount.origin !== "integration"),
  ),
});

export const stripGpgAgentOverlay = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripService(service)]),
  ),
});

export const withGpgAgentOverlay = Effect.fnUntraced(function* (
  plan: AppPlan,
  session: OverlaySession,
  keyringDir: string,
): Effect.fn.Return<AppPlan, GpgAgentTransportError> {
  const services = { ...plan.services };
  for (const service of Object.values(plan.services)) {
    if (!serviceHasGpgAgentFeature(service)) continue;
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
    mounts.push({
      type: "bind",
      origin: "integration",
      source: keyringDir,
      target: keyringTarget,
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    });
    const ordered = orderMounts(mounts);
    const duplicate = duplicateMountTarget(ordered);
    if (duplicate !== undefined) {
      return yield* Effect.fail(
        new GpgAgentTransportError({
          message: `GPG agent mount target ${duplicate} collides with a planned mount on ${service.name}.`,
          stage: "bridge",
          remediation: "Remove the conflicting mount or disable the gpg-agent feature for this service.",
        }),
      );
    }
    services[service.name] = { ...service, environment, mounts: ordered };
  }
  return { ...plan, services };
});
