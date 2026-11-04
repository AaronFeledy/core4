import type { StartedService } from "@lando/sdk/schema";
import { serviceStateRow } from "../service-summary";

export const renderGlobalServiceRow = (service: StartedService): string => serviceStateRow(service);
