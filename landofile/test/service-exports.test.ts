import { describe, expect, test } from "bun:test";

import * as service from "../src/service.ts";

describe("Landofile service exports", () => {
  test("exports layer(options) without a package-owned default Live layer or make*Live factory", () => {
    // Given / When
    const exportedNames = Object.keys(service);

    // Then
    expect(exportedNames).toContain("layer");
    expect(exportedNames).not.toContain("makeLandofileServiceLive");
    expect(exportedNames).not.toContain("LandofileServiceLive");
  });
});
