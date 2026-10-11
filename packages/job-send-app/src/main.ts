// `node dist/main.mjs`: read the configuration, start the service, listen on PORT, and stop cleanly on
// SIGINT or SIGTERM. A configuration problem exits with the names of the variables to fix.

import { ConfigError, loadConfig } from "./config.js";
import { startService } from "./service.js";

try {
  const config = loadConfig(process.env);
  const service = await startService(config);
  service.server.listen(config.port, () => console.log(`job-send listening on port ${config.port} for ${config.host}`));
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: stopping`);
    service.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
} catch (error) {
  if (error instanceof ConfigError) {
    for (const p of error.problems) console.error(`config: ${p.name} ${p.problem}`);
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
}
