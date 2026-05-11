import { chmod, mkdir } from "node:fs/promises";

import * as esbuild from "esbuild";

await mkdir("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["bin/lavish-axi.js"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.LAVISH_AXI_BUILD_UMAMI_HOST": JSON.stringify(process.env.LAVISH_AXI_UMAMI_HOST || ""),
    "process.env.LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID": JSON.stringify(process.env.LAVISH_AXI_UMAMI_WEBSITE_ID || ""),
  },
});

await chmod("dist/cli.mjs", 0o755);
