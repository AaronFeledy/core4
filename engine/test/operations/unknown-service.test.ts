import { expect, test } from "bun:test";
import { unknownPlanServiceError } from "../../src/operations/unknown-service.ts";

for (const prefix of ["exec", "shell", "meta:global:start", "meta:global:info"] as const) {
  for (const names of [[], ["web"], ["zebra", "web", "alpha"]]) {
    test(`${prefix} reports unknown services when ${names.length} services are planned`, () => {
      // Given
      const global = prefix.startsWith("meta:");
      const tool = global ? prefix : `app:${prefix}`;
      const services = Object.fromEntries(names.map((name) => [name, { name }]));
      const planLabel = global ? "global app plan" : "app plan";
      const example =
        prefix === "exec"
          ? "Example: lando exec FIRST -- <command>"
          : `Example: lando ${global ? prefix.slice(5) : prefix} --service FIRST`;
      const first = names.length === 3 ? "alpha" : "web";
      // When
      const error = unknownPlanServiceError({
        prefix,
        tool,
        requested: "nosuch",
        services,
        planLabel,
        remediation: (name) => (prefix === "meta:global:info" ? undefined : example.replace("FIRST", name)),
      });
      // Then
      expect(error._tag).toBe("ToolingExecError");
      expect(error.message).toBe(
        `${prefix}: service nosuch is not in the ${planLabel}${names.length === 0 ? "." : names.length === 1 ? " (available: web)." : " (available: alpha, web, zebra)."}`,
      );
      expect(error.tool).toBe(tool);
      expect(error.remediation).toBe(
        names.length === 0 || prefix === "meta:global:info" ? undefined : example.replace("FIRST", first),
      );
    });
  }
}
