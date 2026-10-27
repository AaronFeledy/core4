import { expect, test } from "bun:test";
import { ScratchAppError } from "@lando/sdk/errors";
import { AppPlan, PortablePath } from "@lando/sdk/schema";
import { Schema } from "effect";
import { decodeScratchPlan } from "../../src/scratch-app/service.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

test("scratch cache migration preserves the legacy app, storage, and raw volume mounts", () => {
  const wire = Schema.encodeSync(AppPlan)(plan);
  const legacy = {
    ...wire,
    services: {
      [web.name]: {
        ...wire.services[web.name],
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
  const wire = Schema.encodeSync(AppPlan)(plan);
  const legacy = {
    ...wire,
    services: {
      [web.name]: {
        ...wire.services[web.name],
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
