import { defineConfig } from "vitest/config";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  oxc: {
    tsconfig: {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
      },
    },
  },
});
