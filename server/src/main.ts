import { boot } from "./boot.ts";
import { loadConfig } from "./config.ts";

const fileConfigPath = process.env["GANGWAY_CONFIG"];
const fileConfig = fileConfigPath ? (await Bun.file(fileConfigPath).json() as Record<string, unknown>) : {};
const config = loadConfig(process.env, fileConfig);
const running = await boot(config);

console.log(`
  gangway   ${running.origin("app")}
  api       ${running.origin("api")}/v1${running.caPath ? `\n  dev CA    ${running.caPath}   (curl --cacert)` : ""}
`);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // a second signal means "now"
    stopping = true;
    // stop() bounds itself; this bounds stop(). Nothing may keep a SIGTERM'd process alive.
    setTimeout(() => process.exit(1), config.shutdownGraceMs + 5_000).unref();
    void running.stop().then(() => process.exit(0), () => process.exit(1));
  });
}
