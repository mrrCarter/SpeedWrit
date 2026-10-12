import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/dial": "http://127.0.0.1:5175" } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
