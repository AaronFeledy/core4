import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { loadBuiltinRecipe } from "../_support/recipe-output.ts";

test.each(["drupal", "drupal-cms"])(
  "%s preserves Apache/FPM variants through shared compilation",
  async (id) => {
    const apache = await loadBuiltinRecipe(id, { webserver: "apache" });
    const fpm = await loadBuiltinRecipe(id, { webserver: "nginx" });
    const first = apache.document.services?.[ServiceName.make("appserver")];
    const second = fpm.document.services?.[ServiceName.make("appserver")];
    expect(first).toMatchObject({
      type: "php:8.4",
      framework: "drupal",
      composer: "2",
      port: 80,
      allowOverride: true,
    });
    expect(second).toMatchObject({ type: "php:8.4", framework: "drupal", composer: "2", via: "fpm" });
    expect(second?.routes).toBeUndefined();
    expect(second?.port).toBeUndefined();
    expect(fpm.document.services?.[ServiceName.make("edge")]).toMatchObject({
      backend: "appserver",
      type: "nginx",
    });
    if (id === "drupal-cms") {
      expect(second?.mounts).toEqual(first?.mounts);
      expect(second?.build?.artifact).toEqual(first?.build?.artifact);
      expect(second?.mounts).toContainEqual({
        source: "./.lando/php/drupal-cms.ini",
        target: "/usr/local/etc/php/conf.d/50-lando-drupal-cms.ini",
        readOnly: true,
      });
    }
  },
);
