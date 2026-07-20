import * as esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const serve = process.argv.includes("--serve");
const outputDirectory = new URL("../dist/", import.meta.url);
const assetDirectory = new URL("../dist/assets/", import.meta.url);
const providerIconSourceDirectory = new URL(
  "../src/assets/provider-icons/",
  import.meta.url,
);
const providerIconOutputDirectory = new URL(
  "../dist/assets/provider-icons/",
  import.meta.url,
);
const providerIconNames = [
  "browser.svg",
  "claude-code.svg",
  "codex.svg",
  "grok.svg",
  "opencode.svg",
  "powershell.svg",
];
const entryPoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const scriptOutput = fileURLToPath(
  new URL("../dist/assets/main.js", import.meta.url),
);
const serveDirectory = fileURLToPath(outputDirectory);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(assetDirectory, { recursive: true });
await mkdir(providerIconOutputDirectory, { recursive: true });
await copyFile(
  new URL("../index.html", import.meta.url),
  new URL("../dist/index.html", import.meta.url),
);
await Promise.all(
  providerIconNames.map((name) =>
    copyFile(
      new URL(name, providerIconSourceDirectory),
      new URL(name, providerIconOutputDirectory),
    ),
  ),
);

const context = await esbuild.context({
  entryPoints: [entryPoint],
  bundle: true,
  format: "esm",
  target: ["es2020"],
  outfile: scriptOutput,
  minify: !serve,
  sourcemap: serve,
  legalComments: "none",
  logLevel: "info",
});

await context.rebuild();

if (!serve) {
  await context.dispose();
} else {
  await context.watch();
  const server = await context.serve({
    host: process.env.TAURI_DEV_HOST || "127.0.0.1",
    port: 1420,
    servedir: serveDirectory,
  });
  console.log(`IHATECODING UI: http://${server.host}:${server.port}`);

  const shutdown = async () => {
    await context.dispose();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise(() => {});
}
