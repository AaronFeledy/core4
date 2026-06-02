import { mergeLandofiles } from "../../src/landofile/merge.ts";

describe("mergeLandofiles", () => {
  test("deep-merges maps with later scalar precedence", () => {
    const result = mergeLandofiles([
      { services: { appserver: { type: "node", environment: { A: "1", B: "base" } } } },
      { services: { appserver: { environment: { B: "override", C: "2" } } } },
    ]);

    expect(result).toEqual({
      services: { appserver: { type: "node", environment: { A: "1", B: "override", C: "2" } } },
    });
  });

  test("replaces scalar arrays instead of concatenating", () => {
    const result = mergeLandofiles([
      { services: { web: { ports: ["80", "443"] } } },
      { services: { web: { ports: ["3000"] } } },
    ]);

    expect(result).toEqual({ services: { web: { ports: ["3000"] } } });
  });

  test("merges object arrays by the first recognized identity key", () => {
    const result = mergeLandofiles([
      { services: { web: { routes: [{ hostname: "old.lndo.site", pathPrefix: "/" }] } } },
      {
        services: {
          web: { routes: [{ hostname: "old.lndo.site", scheme: "https" }, { hostname: "new.lndo.site" }] },
        },
      },
    ]);

    expect(result).toEqual({
      services: {
        web: {
          routes: [
            { hostname: "old.lndo.site", pathPrefix: "/", scheme: "https" },
            { hostname: "new.lndo.site" },
          ],
        },
      },
    });
  });

  test("replaces arrays of objects that have no recognized identity key", () => {
    const result = mergeLandofiles([
      { services: { web: { mounts: [{ source: "./one", target: "/one" }] } } },
      { services: { web: { mounts: [{ source: "./two", target: "/two" }] } } },
    ]);

    expect(result).toEqual({ services: { web: { mounts: [{ source: "./two", target: "/two" }] } } });
  });

  test("folds files low to high precedence so the including file wins", () => {
    const result = mergeLandofiles([
      { name: "base", services: { web: { type: "php" } } },
      { name: "final", services: { web: { type: "node" } } },
    ]);

    expect(result).toEqual({ name: "final", services: { web: { type: "node" } } });
  });
});
