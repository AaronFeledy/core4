import { describe, expect, test } from "bun:test";

import {
  LARAVEL_DATABASES,
  SYMFONY_DATABASES,
  WEBROOT_PATTERN,
  renderDatabaseLines,
  renderNginxEdgeLines,
  renderPhpAppserverLines,
  renderPrimaryRouteLines,
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
      appName: "test-app",
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
      appName: "test-app",
    });
    const yaml = lines.join("\n");
    expect(yaml).toContain("via: fpm");
    expect(yaml).not.toContain("allowOverride:");
    expect(yaml).not.toContain("port: 80");
    const edge = renderNginxEdgeLines("/app/web", "test-app").join("\n");
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
      appName: "test-app",
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

  test("renderPrimaryRouteLines emits the expression hostname and primary-URL comment", () => {
    // Given / When
    const lines = renderPrimaryRouteLines("my-app");

    // Then
    expect(lines).toEqual([
      "    # primary URL: http(s)://my-app.lndo.site",
      "    routes:",
      '      - hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"',
      "        scheme: both",
    ]);
  });

  test("apache appserver YAML contains routes, expression hostname, and primary-URL comment", () => {
    // Given / When
    const yaml = renderPhpAppserverLines({
      php: "8.3",
      webroot: "/app",
      composer: "2",
      webserver: "apache",
      allowOverride: true,
      port: 80,
      dependsOn: ["database"],
      appName: "apache-app",
    }).join("\n");

    // Then
    expect(yaml).toContain("# primary URL: http(s)://apache-app.lndo.site");
    expect(yaml).toContain("    routes:");
    expect(yaml).toContain('hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"');
    expect(yaml).toContain("scheme: both");
  });

  test("nginx places routes on edge and none on the fpm appserver", () => {
    // Given / When
    const appserver = renderPhpAppserverLines({
      php: "8.4",
      webroot: "/app/web",
      composer: "2.7.7",
      webserver: "nginx",
      dependsOn: ["database"],
      appName: "nginx-app",
    }).join("\n");
    const edge = renderNginxEdgeLines("/app/web", "nginx-app").join("\n");

    // Then
    expect(appserver).toContain("via: fpm");
    expect(appserver).not.toContain("routes:");
    expect(appserver).not.toContain("{{ app.name }}");
    expect(edge).toContain("# primary URL: http(s)://nginx-app.lndo.site");
    expect(edge).toContain("    routes:");
    expect(edge).toContain('hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"');
    expect(edge).not.toContain("via: fpm");
  });
});
