import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = loadConfig(process.env);
  createApp(config).listen(config.port, "0.0.0.0", () => {
    console.log(`IGUP broker is listening on port ${config.port}`);
  });
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exitCode = 1;
}
