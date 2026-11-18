import { expect, test } from "bun:test";
import { ScratchAppError } from "@lando/sdk/errors";
import { AppPlan, PortablePath } from "@lando/sdk/schema";
import { Schema } from "effect";
import { decodeScratchPlan } from "../../src/scratch-app/service.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

/** Scratch cache bytes from before endpoint/filter `kind` used `_tag` / `type`. */
const asPreKindWire = (wire: unknown): unknown => {
  if (typeof wire !== "object" || wire === null) return wire;
  const record = wire as Record<string, unknown>;
  const servicesIn = record.services;
  if (typeof servicesIn !== "object" || servicesIn === null) return wire;
  const services = Object.fromEntries(
    Object.entries(servicesIn as Record<string, unknown>).map(([name, service]) => {
      if (typeof service !== "object" || service === null) return [name, service];
      const svc = service as Record<string, unknown>;
      const endpoints = Array.isArray(svc.endpoints)
        ? svc.endpoints.map((item) => {
            if (typeof item !== "object" || item === null || !("kind" in item)) return item;
            const { kind, ...rest } = item as Record<string, unknown>;
            return { ...rest, _tag: kind };
          })
        : svc.endpoints;
      return [name, { ...svc, endpoints }];
    }),
  );
  const routes = Array.isArray(record.routes)
    ? record.routes.map((route) => {
        if (typeof route !== "object" || route === null) return route;
        const r = route as Record<string, unknown>;
        if (!Array.isArray(r.filters)) return route;
        return {
          ...r,
          filters: r.filters.map((item) => {
            if (typeof item !== "object" || item === null || !("kind" in item)) return item;
            const { kind, ...rest } = item as Record<string, unknown>;
            return { ...rest, type: kind };
          }),
        };
      })
    : record.routes;
  return { ...record, services, routes };
};

test("scratch cache migration preserves the legacy app, storage, and raw volume mounts", () => {
  const wire = asPreKindWire(Schema.encodeSync(AppPlan)(plan)) as Record<string, unknown>;
  const services = wire.services as Record<string, Record<string, unknown>>;
  const legacy = {
    ...wire,
    services: {
      [web.name]: {
        ...services[web.name],
        appMount: {
          source: "/old",
          target: "/app",
          readOnly: false,
          realization: "accelerated",
          excludes: [],
          includes: [],
        },
        storage: [{ store: "data", target: "/data", readOnly: false }],
        mounts: [
          {
            type: "volume",
            source: "legacy-cache",
            target: "/cache",
            readOnly: true,
            realization: "passthrough",
          },
        ],
      },
    },
  };
  const result = decodeScratchPlan(legacy);
  expect(result.services[web.name]?.mounts).toEqual([
    {
      type: "bind",
      role: "app",
      source: "/old",
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "accelerated",
      mountKey: "app-mount",
      excludes: [],
      includes: [],
    },
    { type: "volume", store: "legacy-cache", target: PortablePath.make("/cache"), readOnly: true },
    { type: "volume", store: "data", target: PortablePath.make("/data"), readOnly: false },
  ]);
});

test("scratch cache migration fails closed for an ambiguous legacy target", () => {
  const wire = asPreKindWire(Schema.encodeSync(AppPlan)(plan)) as Record<string, unknown>;
  const services = wire.services as Record<string, Record<string, unknown>>;
  const legacy = {
    ...wire,
    services: {
      [web.name]: {
        ...services[web.name],
        mounts: [],
        storage: [
          { store: "first", target: "/data", readOnly: false },
          { store: "second", target: "/data", readOnly: false },
        ],
      },
    },
  };
  expect(() => decodeScratchPlan(legacy)).toThrow(ScratchAppError);
});

test("scratch cache decoding preserves current mount identities", () => {
  const current: AppPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        mounts: [
          {
            type: "bind",
            source: "/host",
            target: PortablePath.make("/app"),
            readOnly: false,
            realization: "accelerated",
            mountKey: "stable-key",
          },
        ],
      },
    },
  };
  expect(decodeScratchPlan(Schema.encodeSync(AppPlan)(current))).toEqual(current);
});
