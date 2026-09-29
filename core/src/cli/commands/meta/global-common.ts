import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type { GlobalStartedService } from "./global-start";

export const globalAppRef = (plan: Pick<AppPlan, "id" | "root">): AppRef => ({
  kind: "global",
  id: plan.id,
  root: plan.root,
});

export const renderGlobalServiceRow = (service: GlobalStartedService): string => {
  const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
  return `${service.name} (${service.state}) ${endpoints}`;
};
