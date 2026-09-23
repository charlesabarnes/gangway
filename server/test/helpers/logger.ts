import { Logger } from "../../src/logger.ts";

/** A logger that drops everything. */
export const silentLogger = () => new Logger("error", {}, () => {});
