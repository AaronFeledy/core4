import { describe, expect, test } from "bun:test";

import {
  LARAVEL_DATABASES,
  SYMFONY_DATABASES,
  WEBROOT_PATTERN,
  renderDatabaseLines,
  renderNginxEdgeLines,
  renderPhpAppserverLines,
  resolvePhpStackAnswers,
} from "../../src/recipes/builtin/php-stack.ts";

describe("php-stack helper", () => {
  test("resolves lamp defaults from empty extras", () => {
    const resolved = resolvePhpStackAnswers(
      {},
      { php: "8.3", database: "mariadb:11.4", webroot: "/app", composer: "2" },
    );
    expect(resolved.php).toBe("8.3");
    expect(resolved.database).toBe("mariadb:11.4");
    expect(resolved.webroot).toBe("/app");
    expect(resolved.composer).toBe("2");
    expect(resolved.webserver).toBe("apache");
  });

  test("webroot pattern accepts container paths and rejects relatives", () => {
    expect(WEBROOT_PATTERN.test("/app")).toBe(true);
    expect(WEBROOT_PATTERN.test("/app/web")).toBe(true);
    expect(WEBROOT_PATTERN.test("/app/public")).toBe(true);
    expect(WEBROOT_PATTERN.test("relative")).toBe(false);
    expect(WEBROOT_PATTERN.test("app/web")).toBe(false);
  });

  test("apache appserver omits via and can keep allowOverride", () => {
    const lines = renderPhpAppserverLines({
      php: "8.3",
      webroot: "/app",
      composer: "2",
      webserver: "apache",
      allowOverride: true,
      port: 80,
      dependsOn: ["database"],
    });
    const yaml = lines.join("\n");
    expect(yaml).toContain("type: php:8.3");
    expect(yaml).not.toContain("via:");
    expect(yaml).toContain("allowOverride: true");
    expect(yaml).toContain("port: 80");
    expect(yaml).toContain('composer: "2"');
  });

  test("nginx appserver emits via fpm without allowOverride or port", () => {
    const lines = renderPhpAppserverLines({
      php: "8.4",
      webroot: "/app/web",
      composer: "2.7.7",
      webserver: "nginx",
      dependsOn: ["database"],
    });
    const yaml = lines.join("\n");
    expect(yaml).toContain("via: fpm");
    expect(yaml).not.toContain("allowOverride:");
    expect(yaml).not.toContain("port: 80");
    const edge = renderNginxEdgeLines("/app/web").join("\n");
    expect(edge).toContain("backend: appserver");
    expect(edge).toContain("webroot: /app/web");
  });

  test("composer false emits a boolean and skips the quoted string", () => {
    const lines = renderPhpAppserverLines({
      php: "8.3",
      webroot: "/app",
      composer: false,
      webserver: "apache",
      dependsOn: ["database"],
    });
    expect(lines.join("\n")).toMatch(/composer:\s+false\b/);
    expect(lines.join("\n")).not.toContain('composer: "false"');
  });

  test("database lines emit the versioned type", () => {
    expect(renderDatabaseLines("mariadb:11.4").join("\n")).toContain("type: mariadb:11.4");
    expect(renderDatabaseLines("postgres:16").join("\n")).toContain("type: postgres:16");
  });

  test("laravel and symfony database lists keep engine order for --yes defaults", () => {
    expect(LARAVEL_DATABASES[0]).toBe("mariadb:11.4");
    expect(LARAVEL_DATABASES).toContain("postgres:16");
    expect(SYMFONY_DATABASES[0]).toBe("postgres:16");
    expect(SYMFONY_DATABASES).toContain("mariadb:11.4");
  });
});
