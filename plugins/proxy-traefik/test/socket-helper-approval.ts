import { makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import type { ProxyConfig } from "@lando/sdk/schema";
import type {
  HostChangeApplier,
  PrivilegeService,
  PrivilegeSession,
  RouterServiceShape,
} from "@lando/sdk/services";
import { Effect } from "effect";
import type { SocketProxyDependencies, TraefikProxyDependencies } from "../src/proxy-types.ts";
import { planSocketHelper, socketHelperProposal } from "../src/socket-proxy-plan.ts";

const approveAll = (
  proposals: Parameters<typeof makeHostChangeApplier>[0]["proposals"],
  elevate: PrivilegeSession["elevate"],
): HostChangeApplier =>
  makeHostChangeApplier({
    proposals,
    approved: new Set(proposals.map(({ change }) => change.id)),
    session: { transport: "direct", elevate },
    redact: (text) => text,
  }).applier;

/** Plan the router's helper the way setup does and approve it; installs run through `elevate`. */
export const approvedRouterHelper = (
  router: RouterServiceShape,
  config: ProxyConfig,
  elevate: PrivilegeSession["elevate"],
) =>
  Effect.map(router.planHostChanges?.(config) ?? Effect.succeed([]), (proposals) =>
    approveAll(proposals, elevate),
  );

/** Router dependencies plus the setup session the approved helper change elevates through. */
export type ApprovingDependencies = Omit<TraefikProxyDependencies, "socketProxy"> & {
  readonly socketProxy?: SocketProxyDependencies & {
    /** Root as setup's session runs it; only the approved helper change reaches it. */
    readonly privilege?: Pick<typeof PrivilegeService.Service, "elevate">;
  };
};

/** The same for acquisition-level tests: a configure-intent socket proxy carrying the approval. */
export const withApprovedHelper = Effect.fnUntraced(function* (dependencies: ApprovingDependencies) {
  if (dependencies.socketProxy === undefined)
    return yield* Effect.die("the test must provide socket proxy dependencies");
  const { privilege, ...socketProxy } = dependencies.socketProxy;
  const planning = { ...dependencies, socketProxy: { ...socketProxy, intent: "configure" as const } };
  const plan = yield* planSocketHelper(planning);
  const hostChanges = approveAll(
    plan === undefined ? [] : [socketHelperProposal(planning, plan)],
    privilege?.elevate ?? (() => Effect.die("the approved helper change ran as root")),
  );
  return { ...planning, socketProxy: { ...planning.socketProxy, hostChanges } };
});
