import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  GlobalConfig,
  HistoryConfig,
  HISTORY_CLIENT_FILES,
  HISTORY_DEFAULT_SERVICE_TYPES,
  HISTORY_FEATURE_ID,
  HISTORY_MOUNT_TARGET,
  historyFilePath,
  historyStoreName,
  isHistoryDefaultServiceType,
  isHistoryMountTarget,
  isHistoryStoreName,
  shouldAttachHistoryVolume,
} from "@lando/sdk/schema";

describe("history schema helpers", () => {
  test("names the app-scoped store and mount", () => {
    expect(HISTORY_FEATURE_ID).toBe("service-lando.history");
    expect(historyStoreName("myapp")).toBe("lando-myapp-history");
    expect(isHistoryStoreName("lando-myapp-history")).toBe(true);
    expect(isHistoryStoreName("myapp-mysql-data")).toBe(false);
    expect(isHistoryMountTarget(HISTORY_MOUNT_TARGET)).toBe(true);
    expect(historyFilePath("db", HISTORY_CLIENT_FILES.MYSQL_HISTFILE)).toBe(
      `${HISTORY_MOUNT_TARGET}/db.mysql_history`,
    );
  });

  test("defaults on for known client families", () => {
    expect(HISTORY_DEFAULT_SERVICE_TYPES).toContain("mysql");
    expect(HISTORY_DEFAULT_SERVICE_TYPES).toContain("php:8.3");
    expect(isHistoryDefaultServiceType("mysql:8.4")).toBe(true);
    expect(isHistoryDefaultServiceType("nginx")).toBe(false);
    expect(shouldAttachHistoryVolume({ serviceType: "php:8.3" })).toBe(true);
    expect(shouldAttachHistoryVolume({ serviceType: "nginx" })).toBe(false);
    expect(shouldAttachHistoryVolume({ serviceType: "nginx", history: true })).toBe(true);
    expect(shouldAttachHistoryVolume({ serviceType: "php:8.3", history: false })).toBe(false);
  });

  test("decodes HistoryConfig and GlobalConfig.history", () => {
    expect(Schema.decodeUnknownSync(HistoryConfig)({ enabled: false }).enabled).toBe(false);
    expect(Schema.decodeUnknownSync(GlobalConfig)({ history: { enabled: false } }).history).toEqual({
      enabled: false,
    });
  });
});
