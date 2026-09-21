import { boot } from "./boot.ts";
import { loadConfig } from "./config.ts";

const fileConfigPath = process.env["GANGWAY_CONFIG"];
const fileConfig = fileConfigPath ? (await Bun.file(fileConfigPath).json() as Record<string, unknown>) : {};
const running = await boot(loadConfig(process.env, fileConfig));

console.log(`
  gangway   ${running.origin("app")}
  api       ${running.origin("api")}/v1${running.caPath ? `\n  dev CA    ${running.caPath}   (curl --cacert)` : ""}
`);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    void running.stop().finally(() => process.exit(0));
  });
}
