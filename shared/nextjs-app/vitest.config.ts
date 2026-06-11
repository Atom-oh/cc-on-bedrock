import { defineConfig } from "vitest/config";
import path from "path";

// Resolve the Next.js "@/*" → "./src/*" path alias for vitest (mirrors tsconfig paths).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
