import { type AppPlan, planAppIdentity } from "@lando/sdk/schema";
import { isScratchPlan } from "./build-app-kind.ts";

/** Construction requires a plan or canonical teardown root, never a display name. */
export class BuildOwner {
  private constructor(
    readonly kind: "root" | "scratch",
    private readonly ownerKey: string,
  ) {}

  get key(): string {
    return this.ownerKey;
  }

  static fromPlan(plan: AppPlan): BuildOwner {
    return isScratchPlan(plan)
      ? BuildOwner.scratch(plan.id)
      : new BuildOwner("root", planAppIdentity(plan).ownerKey);
  }

  static root(root: AppPlan["root"]): BuildOwner {
    return new BuildOwner("root", planAppIdentity({ root }).ownerKey);
  }

  static scratch(id: AppPlan["id"]): BuildOwner {
    return new BuildOwner("scratch", id);
  }
}
