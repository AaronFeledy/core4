import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { Schema } from "effect";

const DockerNetworkCreate = Schema.Struct({
  Name: Schema.String,
  Driver: Schema.String,
  Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const NativeNetworkCreate = Schema.Struct({
  name: Schema.String,
  driver: Schema.Literal("bridge"),
  dns_enabled: Schema.Literal(true),
  options: Schema.Struct({ metric: Schema.Literal("50") }),
  labels: Schema.Record(Schema.String, Schema.String),
});

/** Decode only actual network-create requests, preserving the submitted proof. */
export const decodeNetworkCreate = (request: EngineHttpRequest) => {
  if (request.method !== "POST") return undefined;
  if (request.path === "/networks/create") return Schema.decodeUnknownSync(DockerNetworkCreate)(request.body);
  if (request.path === "/libpod/networks/create") {
    const body = Schema.decodeUnknownSync(NativeNetworkCreate)(request.body);
    return { Name: body.name, Driver: body.driver, Labels: body.labels };
  }
  return undefined;
};
