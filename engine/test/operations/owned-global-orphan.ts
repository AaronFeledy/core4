import { type AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";

export const ownedGlobalOrphan = (root: AbsolutePath, dataRoot: string): ServiceRuntimeInfo => ({
  app: AppId.make("global"),
  appRoot: root,
  service: ServiceName.make("ssh-agent"),
  providerId: ProviderId.make("lando"),
  status: "running",
  containerId: "owned-container",
  publications: { status: "unknown" },
  labels: {
    "dev.lando.app": "global",
    "dev.lando.app-root": root,
    "dev.lando.service": "ssh-agent",
    "dev.lando.data-root": dataRoot,
  },
});
