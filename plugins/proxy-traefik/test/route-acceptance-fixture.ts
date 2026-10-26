import { acquisitionStateFile, defaultDomainFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisition } from "./observe-routes-fixture.ts";
import { makeHarness } from "./proxy-tls-harness.ts";

export const makeAcceptanceFixture = (platform: "linux" | "darwin" | "win32" | "wsl" = "linux") => {
  const harness = makeHarness();
  const dependencies = { ...harness.dependencies, paths: { ...harness.dependencies.paths, platform } };
  harness.files.set(acquisitionStateFile(dependencies.paths), JSON.stringify(acquisition));
  harness.files.set(defaultDomainFile(dependencies.paths), "lndo.site\n");
  const makeService = () => makeTraefikRouterService(dependencies);
  return { ...harness, dependencies, makeService, service: makeService() };
};
