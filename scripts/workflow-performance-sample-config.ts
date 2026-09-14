import type { WorkflowPerformanceLaneId } from "./workflow-performance-plan.ts";

export const imagesFor = (laneId: WorkflowPerformanceLaneId): readonly string[] => {
  if (laneId.startsWith("mysql-")) return ["mysql:8.0"];
  if (laneId.startsWith("postgres-")) return ["postgres:16"];
  if (laneId === "drupal-journey") return ["php:8.3-apache-bookworm", "mariadb:11.4", "traefik:v3.3"];
  if (laneId === "rails-journey") return ["ruby:3.3-slim", "postgres:16", "redis:7", "traefik:v3.3"];
  return ["node:22"];
};

export const landofileFor = (laneId: WorkflowPerformanceLaneId, name: string): string => {
  const type = laneId.startsWith("mysql-")
    ? "mysql:8.0"
    : laneId.startsWith("postgres-")
      ? "postgres:16"
      : "node:22";
  return `name: ${name}\nruntime: 4\nservices:\n  ${type === "node:22" ? "app" : "database"}:\n    type: ${type}\n`;
};
