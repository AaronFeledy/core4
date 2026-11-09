import { Schema } from "effect";
import type { DataPlaneHttpRequest } from "../../src/data-plane.ts";
import { FakeEngineContractError } from "./fake-engine-state.ts";

export type Operation =
  | "engine.info"
  | "container.create"
  | "container.start"
  | "container.wait"
  | "container.inspect"
  | "container.attach"
  | "container.logs"
  | "container.delete"
  | "container.list"
  | "archive.put"
  | "archive.get"
  | "volume.create"
  | "volume.inspect"
  | "volume.list"
  | "volume.delete"
  | "image.inspect"
  | "image.commit"
  | "image.load"
  | "image.get"
  | "image.delete"
  | "image.pull"
  | "image.list";

export const Filters = Schema.fromJsonString(
  Schema.Struct({
    label: Schema.optionalKey(Schema.Array(Schema.String)),
    volume: Schema.optionalKey(Schema.Array(Schema.String)),
    reference: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

export const route = (input: DataPlaneHttpRequest) => {
  const url = new URL(input.path, "http://fake-engine");
  const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  const [resource, name = "", action] = parts;
  let operation: Operation | undefined;
  const key = `${input.method} ${resource} ${action ?? name}`;
  switch (key) {
    case "GET info ":
      operation = "engine.info";
      break;
    case "POST containers create":
      operation = "container.create";
      break;
    case "POST containers start":
      operation = "container.start";
      break;
    case "POST containers wait":
      operation = "container.wait";
      break;
    case "POST containers attach":
      operation = "container.attach";
      break;
    case "GET containers logs":
      operation = "container.logs";
      break;
    case "GET containers json":
      operation = parts.length === 2 ? "container.list" : "container.inspect";
      break;
    case "PUT containers archive":
      operation = "archive.put";
      break;
    case "GET containers archive":
      operation = "archive.get";
      break;
    case "POST volumes create":
      operation = "volume.create";
      break;
    case "GET volumes ":
      operation = "volume.list";
      break;
    case "GET images json":
      operation = name === "json" ? "image.list" : "image.inspect";
      break;
    case "GET images get":
      operation = "image.get";
      break;
    case "POST images load":
      operation = "image.load";
      break;
    case "POST images create":
      operation = "image.pull";
      break;
    case "POST commit ":
      operation = "image.commit";
      break;
    default:
      if (parts.length === 2 && input.method === "DELETE") {
        if (resource === "containers") operation = "container.delete";
        if (resource === "volumes") operation = "volume.delete";
        if (resource === "images") operation = "image.delete";
      }
      if (parts.length === 2 && resource === "volumes" && input.method === "GET")
        operation = "volume.inspect";
  }
  if (operation === undefined || parts.length > 3)
    throw new FakeEngineContractError(`${input.method} ${input.path}`);
  return { operation, url, name };
};
