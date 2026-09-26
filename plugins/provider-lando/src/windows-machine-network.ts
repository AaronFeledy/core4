import { type AppPlan, landoNetworkingPlan } from "@lando/sdk/schema";

const digest = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12);

/**
 * Keep logical app DNS aliases while isolating Podman's physical bridges from
 * stale Netavark rules left in the WSL network namespace by another VM.
 */
export const windowsMachineNetworkPlan = (plan: AppPlan, createdAt: string): AppPlan => {
  const networking =
    plan.networking ??
    landoNetworkingPlan({
      slug: plan.slug,
      serviceNames: Object.keys(plan.services),
      sharedCrossAppNetwork: true,
    });
  const generation = digest(createdAt);
  const physical = (name: string) => {
    const existing = /^lando-vm-([0-9a-f]{12})-[0-9a-f]{12}$/u.exec(name);
    if (existing !== null) {
      if (existing[1] !== generation)
        throw new Error("Network plan belongs to another Podman machine generation");
      return name;
    }
    return `lando-vm-${generation}-${digest(name)}`;
  };
  return {
    ...plan,
    networking: {
      ...networking,
      perAppBridge: { ...networking.perAppBridge, name: physical(networking.perAppBridge.name) },
      ...(networking.sharedNetworkMembership === undefined
        ? {}
        : {
            sharedNetworkMembership: {
              ...networking.sharedNetworkMembership,
              name: physical(networking.sharedNetworkMembership.name),
            },
          }),
    },
  };
};
