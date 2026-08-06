import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { importCycleRule } from "../../../scripts/boundary/rules/import-cycle.ts";
import { WORKSPACE_EDGE_TABLE } from "../../../scripts/boundary/rules/package-dag-policy.ts";
import { packageDagRule } from "../../../scripts/boundary/rules/package-dag.ts";
import { type PackageDagFixture, createPackageDagFixture } from "./package-dag-fixture.ts";

let fixture: PackageDagFixture;

beforeEach(async () => {
  fixture = await createPackageDagFixture();
});

afterEach(async () => {
  await fixture.dispose();
});

describe("check-package-dag source policy", () => {
  test("rejects plugin source imports from core without a runtime manifest edge", async () => {
    // Given
    await fixture.write("plugins/provider-lando/src/index.ts", 'import "@lando/core/scratch";\n');

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("plugins/provider-lando/src/index.ts:1: @lando/core/scratch");
  });

  test.each(["@lando/engine", "@lando/engine/runtime"])(
    "rejects plugin source import %s before the engine package exists",
    async (specifier) => {
      // Given
      await fixture.write("plugins/provider-lando/src/index.ts", `import "${specifier}";\n`);

      // When
      const result = await fixture.runGate(["--report"]);

      // Then
      expect(result.stdout).toContain(`plugins/provider-lando/src/index.ts:1: ${specifier}`);
    },
  );

  test("allows every plugin runtime seam declared by the workspace policy", async () => {
    // Given
    const runtimeTargets = WORKSPACE_EDGE_TABLE["@lando/provider-lando"]?.dependencies;
    if (runtimeTargets === undefined || runtimeTargets === "workspace") {
      throw new TypeError("provider-lando must declare explicit runtime targets");
    }
    await fixture.write(
      "plugins/provider-lando/src/index.ts",
      runtimeTargets.map((target) => `import "${target}";`).join("\n"),
    );

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result).toEqual({ exitCode: 0, stdout: "Package DAG violations: 0\n", stderr: "" });
  });

  test("rejects undeclared cross-plugin source imports", async () => {
    // Given
    await fixture.write(
      "plugins/provider-lando/src/index.ts",
      'void import("@lando/provider-podman/runtime");\n',
    );

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("plugins/provider-lando/src/index.ts:1: @lando/provider-podman/runtime");
  });

  test("rejects separator-escaped package specifiers", async () => {
    // Given
    await Promise.all([
      fixture.write("plugins/provider-lando/src/index.ts", 'import "@lando/sdk\\\\..\\\\core";\n'),
      fixture.write(
        "state-store/src/index.ts",
        'import "@lando/sdk\\\\..\\\\..\\\\plugins\\\\provider-lando\\\\src";\n',
      ),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("plugins/provider-lando/src/index.ts:1: @lando/sdk\\..\\core");
    expect(result.stdout).toContain(
      "state-store/src/index.ts:1: @lando/sdk\\..\\..\\plugins\\provider-lando\\src",
    );
  });

  test("rejects reverse imports from every non-plugin package into plugins", async () => {
    // Given
    await Promise.all([
      fixture.write("container-runtime/src/index.ts", 'import "@lando/provider-lando";\n'),
      fixture.write("core/src/index.ts", 'import "@lando/provider-lando";\n'),
      fixture.write("paths/src/index.ts", 'import "@lando/provider-lando";\n'),
      fixture.write("sdk/src/index.ts", 'import "@lando/provider-lando";\n'),
      fixture.write("state-store/src/index.ts", 'import "@lando/provider-lando";\n'),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    for (const source of ["container-runtime", "core", "paths", "sdk", "state-store"]) {
      expect(result.stdout).toContain(`${source}/src/index.ts:1: @lando/provider-lando`);
    }
  });

  test("allows core plugin imports only from the generated composition root", async () => {
    // Given
    await Promise.all([
      fixture.write("core/src/providers/provider.ts", 'import "@lando/service-lando";\n'),
      fixture.write(
        "core/src/plugins/generated/bundled.ts",
        'export { service } from "@lando/service-lando";\n',
      ),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("core/src/providers/provider.ts:1: @lando/service-lando");
    expect(result.stdout).not.toContain("core/src/plugins/generated/bundled.ts");
  });

  test("scans every production TypeScript module extension", async () => {
    // Given
    await Promise.all([
      fixture.write("plugins/provider-lando/src/index.cts", 'import "@lando/core";\n'),
      fixture.write("plugins/provider-lando/src/index.mts", 'import "@lando/core";\n'),
      fixture.write("plugins/provider-lando/src/index.ts", 'import "@lando/core";\n'),
      fixture.write("plugins/provider-lando/src/index.tsx", 'import "@lando/core";\n'),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    for (const extension of ["cts", "mts", "ts", "tsx"]) {
      expect(result.stdout).toContain(`plugins/provider-lando/src/index.${extension}:1: @lando/core`);
    }
    expect(packageDagRule.scope.extensions[0]).toBe(".json");
    expect(packageDagRule.scope.extensions.slice(1).join(",")).toBe(
      importCycleRule.scope.extensions.join(","),
    );
  });

  test("rejects source package cycles in addition to manifest policy violations", async () => {
    // Given
    await Promise.all([
      fixture.writePackage("plugins/provider-lando", "@lando/provider-lando", {
        dependencies: { "@lando/provider-podman": "workspace:*" },
        devDependencies: { "@lando/core": "workspace:*" },
      }),
      fixture.write("plugins/provider-lando/src/index.ts", 'import "@lando/provider-podman";\n'),
      fixture.write("plugins/provider-podman/src/index.ts", 'import "@lando/provider-lando";\n'),
    ]);

    // When
    const result = await fixture.runGate(["--report"]);

    // Then
    expect(result.stdout).toContain("[PackageDagUndeclaredEdge]");
    expect(result.stdout).toContain("plugins/provider-lando/src/index.ts:1: @lando/provider-podman");
    expect(result.stdout).toContain("plugins/provider-podman/src/index.ts:1: @lando/provider-lando");
  });
});
