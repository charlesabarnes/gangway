import { afterEach } from "bun:test";
import { runCleanups } from "./helpers/cleanup.ts";

afterEach(runCleanups);
