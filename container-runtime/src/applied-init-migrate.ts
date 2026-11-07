import { ServiceConfig } from "@lando/sdk/schema";
import { Predicate, Result, Schema } from "effect";

const decodeInit = Schema.decodeUnknownResult(Schema.Struct({ init: ServiceConfig.fields.init }));

export const migrateAppliedInit = (raw: unknown): unknown | null => {
  if (!Predicate.isObject(raw) || !Predicate.isObject(raw.services)) return null;
  const services: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(raw.services)) {
    if (!Predicate.isObject(service)) return null;
    const extensions = service.extensions;
    const compose = Predicate.isObject(extensions) ? extensions.compose : undefined;
    if (!Predicate.isObject(extensions) || !Predicate.isObject(compose) || !Object.hasOwn(compose, "init")) {
      services[name] = service;
      continue;
    }
    const decoded = decodeInit({ init: compose.init });
    if (Result.isFailure(decoded)) return null;
    const { init: _init, ...remaining } = compose;
    services[name] = {
      ...service,
      ...(service.init === undefined ? decoded.success : {}),
      extensions: { ...extensions, compose: remaining },
    };
  }
  return { ...raw, services };
};
