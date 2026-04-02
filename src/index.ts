import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
