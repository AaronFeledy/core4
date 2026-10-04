import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { serviceStateRow } from "../service-summary";
import type { GlobalStartedService } from "./global-start";

export const globalAppRef = (plan: Pick<AppPlan, "id" | "root">): AppRef => ({
  kind: "global",
  id: plan.id,
  root: plan.root,
});

export const renderGlobalServiceRow = (service: GlobalStartedService): string =>
  serviceStateRow(service.name, service.state, service.endpoints);
