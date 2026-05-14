import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*.{js,jsx,ts,tsx,mjs,cjs,json,md,yml,yaml}": "vp check --fix",
  },
  pack: {
    dts: {
      tsgo: true,
    },
    exports: true,
    publint: true,
    attw: {
      profile: "esm-only",
      level: "error",
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
