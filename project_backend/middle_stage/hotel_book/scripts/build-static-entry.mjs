// Generate a browser-only entry so workerd never has to SSR the home page.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const clientDir = join(projectRoot, "dist", "client");
const manifestPath = join(clientDir, ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const hotelEntry = manifest["app/hotel-app.tsx"];
const browserEntry = manifest["virtual:vinext-app-browser-entry"];

if (!hotelEntry?.file || !browserEntry?.imports?.length) {
  throw new Error("The vinext client manifest is missing the hotel or framework entry.");
}

const frameworkKey = browserEntry.imports.find((key) =>
  key.startsWith("_framework-"),
);
const frameworkEntry = frameworkKey ? manifest[frameworkKey] : null;

if (!frameworkEntry?.file) {
  throw new Error("The vinext client manifest is missing the React framework entry.");
}

const assetNames = await readdir(join(clientDir, "assets"));
const cssName = assetNames.find(
  (name) => name.startsWith("index-") && name.endsWith(".css"),
);

if (!cssName) {
  throw new Error("The compiled hotel stylesheet was not found.");
}

const moduleSource = `import { HotelApp } from "/${hotelEntry.file}";
import { i as loadReact, t as loadReactDomClient } from "/${frameworkEntry.file}";

const React = loadReact();
const { hydrateRoot } = loadReactDomClient();
const root = document.getElementById("hotel-root");

if (!root) throw new Error("Hotel application root is missing.");

hydrateRoot(root, React.createElement(HotelApp), {
  onRecoverableError(error) {
    if (!String(error?.message || error).includes("Hydration failed")) {
      console.error(error);
    }
  },
});
`;

const htmlSource = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="搜索澳门酒店、管理账单，并安全控制 AI 付款权限。" />
    <title>旅屿 · AI 友好的酒店预订</title>
    <link rel="icon" href="/favicon.svg" />
    <link rel="stylesheet" href="/assets/${cssName}" />
  </head>
  <body>
    <main id="hotel-root">
      <div style="min-height:100vh;display:grid;place-items:center;font:16px system-ui;color:#17231f">
        正在加载酒店预订服务…
      </div>
    </main>
    <script type="module" src="/hotel-static-entry.js"></script>
  </body>
</html>
`;

await Promise.all([
  writeFile(join(clientDir, "hotel-static-entry.js"), moduleSource),
  writeFile(join(clientDir, "index.html"), htmlSource),
]);

console.log("Generated the static hotel entry without invoking SSR.");
