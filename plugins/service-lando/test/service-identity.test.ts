import { describe, expect, it } from "bun:test";

import { serviceTypes } from "../src/index.ts";

describe("bundled service image identity", () => {
  // Given the registered catalog, excluding author-supplied images.
  const catalog = [...serviceTypes].filter(([id]) => !["compose", "lando", "minio"].includes(id));

  it("declares identity when the service owns its default image", () => {
    // When
    const missing = catalog.filter(([, serviceType]) => serviceType.identity === undefined);

    // Then
    expect(catalog.length).toBeGreaterThan(0);
    expect(missing.map(([id]) => id)).toEqual([]);
  });

  it("omits the default home only for Varnish images whose user has no home", () => {
    const withoutHome = catalog.filter(([, serviceType]) => {
      const identity = serviceType.identity;
      const principal = identity?.defaultUser.split(":")[0] ?? "";
      return !Object.hasOwn(identity?.homes ?? {}, principal);
    });
    expect(withoutHome.map(([id]) => id).sort()).toEqual(["varnish", "varnish:7"]);
  });

  it("uses absolute paths when declaring user homes", () => {
    for (const [id, serviceType] of catalog) {
      // When
      const homes = Object.values(serviceType.identity?.homes ?? {});

      // Then
      expect(homes.length, id).toBeGreaterThan(0);
      for (const home of homes) expect(home, id).toStartWith("/");
    }
  });

  it("omits identity when the image is author-supplied", () => {
    // Given
    for (const id of ["compose", "lando", "minio"]) {
      // When
      const serviceType = serviceTypes.get(id);

      // Then
      expect(serviceType, id).toBeDefined();
      expect(serviceType?.identity, id).toBeUndefined();
    }
  });
});
