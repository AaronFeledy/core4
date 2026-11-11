import { type AppPlan, landoServiceContainerName } from "@lando/sdk/schema";

export const serviceContainerName = (plan: Pick<AppPlan, "slug">, service: string): string =>
  landoServiceContainerName(plan.slug, service);
