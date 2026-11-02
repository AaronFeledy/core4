import { expect, test } from "bun:test";
import { providerImages } from "@lando/container-runtime/provider-images";
import { imagesFor } from "../../../scripts/workflow-performance-sample-config.ts";

test.each(["mysql-snapshot-restore", "postgres-snapshot-restore"] as const)(
  "pre-pulls the native snapshot helper for %s in a fresh image store",
  (lane) => {
    // Given a snapshot lane with no previously cached helper image.
    // When preparation selects images before snapshot and restore commands.
    const images = imagesFor(lane);
    // Then the native provider's helper is available before measurement.
    const { dataHelper } = providerImages.images;
    expect(images).toContain(`${dataHelper.image}@${dataHelper.digest}`);
    expect(images).toContain(lane === "mysql-snapshot-restore" ? "mysql:8.0" : "postgres:16");
  },
);
