import { describe, expect, test } from "bun:test";
import { AbsolutePath, type AppPlan, PortablePath, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { fileSyncPriorIsCompatibleWithDesired } from "../../src/operations/file-sync-plan.ts";
import { withAcceleratedBind } from "../accelerated-plan.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const worker: ServicePlan = { ...web, name: ServiceName.make("worker"), primary: false, endpoints: [] };
const base: AppPlan = { ...plan, services: { [web.name]: web, [worker.name]: worker } };
const bind = (mountKey: string, source: string, target: string) => ({
  type: "bind" as const,
  source: AbsolutePath.make(source),
  target: PortablePath.make(target),
  readOnly: false,
  realization: "accelerated" as const,
  mountKey,
  excludes: [],
});
const webApp = bind("app-mount", `${plan.root}`, "/app");
const webOnly = withAcceleratedBind(base, web.name, webApp);
const prior = webOnly.fileSync.map(({ session }) => session);

describe("fileSyncPriorIsCompatibleWithDesired", () => {
  test("keeps prior sessions when the desired set is unchanged", () => {
    expect(fileSyncPriorIsCompatibleWithDesired(webOnly, prior)).toBe(true);
  });

  test("keeps prior sessions when only a service with no prior session gains one", () => {
    const withWorker = withAcceleratedBind(webOnly, worker.name, bind("app-mount", `${plan.root}`, "/srv"));
    expect(fileSyncPriorIsCompatibleWithDesired(withWorker, prior)).toBe(true);
  });

  test("rotates when a service that had a session gains another", () => {
    const widened = withAcceleratedBind(webOnly, web.name, bind("data", `${plan.root}/data`, "/data"));
    expect(fileSyncPriorIsCompatibleWithDesired(widened, prior)).toBe(false);
  });

  test("rotates when a prior session's settings changed or it was removed", () => {
    const moved = withAcceleratedBind(base, web.name, bind("app-mount", `${plan.root}`, "/var/www"));
    expect(fileSyncPriorIsCompatibleWithDesired(moved, prior)).toBe(false);
    expect(fileSyncPriorIsCompatibleWithDesired(base, prior)).toBe(false);
  });

  test("has nothing to keep without prior sessions", () => {
    expect(fileSyncPriorIsCompatibleWithDesired(webOnly, [])).toBe(false);
  });
});
