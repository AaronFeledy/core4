import { describe, expect, test } from "bun:test";

import * as service from "../src/service.ts";

describe("Landofile service exports", () => {
  test("exports the service factory without a package-owned default Live layer", () => {
    // Given / When
    const exportedNames = Object.keys(service);

    // Then
    expect(exportedNames).toContain("makeLandofileServiceLive");
    expect(exportedNames).not.toContain("LandofileServiceLive");
  });
});
