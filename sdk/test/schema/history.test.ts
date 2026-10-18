import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  GlobalConfig,
  HISTORY_CLIENT_FILES,
  HISTORY_DEFAULT_SERVICE_TYPES,
  HISTORY_DEFAULT_USER,
  HISTORY_FEATURE_ID,
  HISTORY_MOUNT_TARGET,
  HistoryConfig,
  historyFilePath,
  historyStatusFromPlan,
  historyStoreName,
  isHistoryDefaultServiceType,
  isHistoryMountTarget,
  isHistoryStoreName,
  sanitizeHistoryUser,
  shouldAttachHistoryVolume,
} from "@lando/sdk/schema";

describe("history schema helpers", () => {
  test("names the app-scoped store and mount", () => {
    expect(HISTORY_FEATURE_ID).toBe("service-lando.history");
    expect(historyStoreName("myapp")).toBe("lando-myapp-history");
    expect(isHistoryStoreName("lando-myapp-history", "myapp")).toBe(true);
    expect(isHistoryStoreName("lando-other-history", "myapp")).toBe(false);
    expect(isHistoryStoreName("lando-myapp-history-extra", "myapp")).toBe(false);
    expect(isHistoryStoreName("myapp-mysql-data", "myapp")).toBe(false);
    expect(isHistoryMountTarget(HISTORY_MOUNT_TARGET)).toBe(true);
    expect(historyFilePath("db", HISTORY_CLIENT_FILES.MYSQL_HISTFILE)).toBe(
      `${HISTORY_MOUNT_TARGET}/db.${HISTORY_DEFAULT_USER}.mysql_history`,
    );
    expect(historyFilePath("db", HISTORY_CLIENT_FILES.MYSQL_HISTFILE, "mysql")).toBe(
      `${HISTORY_MOUNT_TARGET}/db.mysql.mysql_history`,
    );
  });

  test("sanitizes the history user token", () => {
    expect(sanitizeHistoryUser(undefined)).toBe(HISTORY_DEFAULT_USER);
    expect(sanitizeHistoryUser("")).toBe(HISTORY_DEFAULT_USER);
    expect(sanitizeHistoryUser("www-data")).toBe("www-data");
    expect(sanitizeHistoryUser("www data")).toBe("www_data");
    expect(sanitizeHistoryUser("***")).toBe(HISTORY_DEFAULT_USER);
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

  test("reports volume and per-service status from a plan", () => {
    const status = historyStatusFromPlan({
      appName: "myapp",
      services: [
        { name: "appserver", storage: [{ target: HISTORY_MOUNT_TARGET }] },
        { name: "nginx", storage: [{ target: "/app" }] },
      ],
    });
    expect(status.volume).toBe("lando-myapp-history");
    expect(status.services).toEqual([
      { service: "appserver", enabled: true },
      { service: "nginx", enabled: false },
    ]);
  });

  test("decodes HistoryConfig and GlobalConfig.history", () => {
    expect(Schema.decodeUnknownSync(HistoryConfig)({ enabled: false }).enabled).toBe(false);
    expect(Schema.decodeUnknownSync(GlobalConfig)({ history: { enabled: false } }).history).toEqual({
      enabled: false,
    });
  });
});
