import { type AppPlan, landoNativeAppSlug, landoServiceContainerName } from "@lando/sdk/schema";

export const serviceContainerName = (plan: Pick<AppPlan, "slug" | "identity">, service: string): string =>
  landoServiceContainerName(landoNativeAppSlug(plan), service);
