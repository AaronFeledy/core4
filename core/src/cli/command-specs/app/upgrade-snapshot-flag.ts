import { booleanFlag } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const upgradeSnapshotFlags = {
  "no-snapshot": Flags.boolean({ description: "Skip restore points before in-place database upgrades." }),
};

export const upgradeSnapshotOptions = (flags: Parameters<typeof booleanFlag>[0]) =>
  booleanFlag(flags, "no-snapshot") ? { noSnapshot: true } : {};
