import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("ships the hotel booking product instead of the starter", async () => {
  const [page, app, layout, css, hosting, staticEntry] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/hotel-app.tsx", projectRoot), "utf8"),
    readFile(new URL("app/layout.tsx", projectRoot), "utf8"),
    readFile(new URL("app/globals.css", projectRoot), "utf8"),
    readFile(new URL(".openai/hosting.json", projectRoot), "utf8"),
    readFile(new URL("scripts/build-static-entry.mjs", projectRoot), "utf8"),
  ]);

  assert.match(page, /HotelApp/);
  assert.match(layout, /旅屿 · AI 友好的酒店预订/);
  assert.match(app, /AI 可以帮你找房和整理账单/);
  assert.match(app, /请求 AI 一次性付款权限/);
  assert.match(app, /价格库存日历/);
  assert.match(css, /\.bill-layout/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(page, /codex-preview|SkeletonPreview/);
  assert.doesNotMatch(app, /Your site is taking shape/);
  assert.doesNotMatch(app, /hotel_harbour/);
  assert.match(app, /createRoot as createHotelRoot/);
  assert.match(staticEntry, /createHotelRoot\(root\)\.render/);
  assert.doesNotMatch(staticEntry, /loadReactDomClient/);
  assert.doesNotMatch(staticEntry, /hydrateRoot/);
  assert.match(staticEntry, /dist", "server", "\.wrangler/);
});
