import { describe, expect, it } from "bun:test";

import { serviceTypes } from "../src/index.ts";

describe("bundled service image identity", () => {
  // Given the registered catalog, excluding author-supplied images.
  const catalog = [...serviceTypes].filter(([id]) => id !== "compose" && id !== "lando");

  it("declares identity when the service owns its default image", () => {
    // When
    const missing = catalog.filter(([, serviceType]) => serviceType.identity === undefined);

    // Then
    expect(catalog.length).toBeGreaterThan(0);
    expect(missing.map(([id]) => id)).toEqual([]);
  });

  it("declares a home when the default user principal is selected", () => {
    for (const [id, serviceType] of catalog) {
      // When
      const identity = serviceType.identity;
      const principal = identity?.defaultUser.split(":")[0];

      // Then
      expect(principal, id).toBeDefined();
      expect(Object.hasOwn(identity?.homes ?? {}, principal ?? ""), id).toBe(true);
    }
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
    for (const id of ["compose", "lando"]) {
      // When
      const serviceType = serviceTypes.get(id);

      // Then
      expect(serviceType, id).toBeDefined();
      expect(serviceType?.identity, id).toBeUndefined();
    }
  });
});
