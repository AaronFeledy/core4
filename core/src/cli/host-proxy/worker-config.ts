import { HostProxyWorkerPaths } from "@lando/engine/subsystems/host-proxy/worker-records";
import { AppPlan } from "@lando/sdk/schema";
import { Schema } from "effect";

export const WorkerInput = Schema.Struct({
  app: Schema.Struct({ kind: Schema.Literals(["user", "scratch"]), id: Schema.String, root: Schema.String }),
  plan: AppPlan,
  paths: HostProxyWorkerPaths,
  shimArtifactPath: Schema.String,
  configDigest: Schema.String,
  shimTarget: Schema.optional(
    Schema.Union([
      Schema.Struct({ os: Schema.Literal("linux"), arch: Schema.Literal("x64") }),
      Schema.Struct({ os: Schema.Literal("linux"), arch: Schema.Literal("arm64") }),
    ]),
  ),
  hostGatewayName: Schema.optional(Schema.String),
});
