/* 纯静态安全回归测试：不启动服务、不打开浏览器，也不会请求高德。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const web = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(web, "app.js"), "utf8");
const login = fs.readFileSync(path.join(web, "login.js"), "utf8");
const index = fs.readFileSync(path.join(web, "index.html"), "utf8");
const loginHtml = fs.readFileSync(path.join(web, "login.html"), "utf8");

assert.doesNotMatch(app, /crowd_write_token|tokenInput|writeToken\s*\(/, "共享写入令牌入口必须删除");
assert.match(app, /credentials:\s*"include"/, "主页面 fetch 必须携带会话 Cookie");
assert.match(login, /credentials:\s*"include"/g, "登录页 fetch 必须携带会话 Cookie");
assert.match(app, /headers\["X-CSRF-Token"\]/, "写请求必须自动加入 CSRF Header");
assert.match(app, /WRITE_METHODS\.has\(method\)/, "CSRF Header 必须覆盖全部写方法");
assert.doesNotMatch(app, /setItem\([^\n]*(api_key|fullKey|createdKeyValue)/i, "完整 API Key 不得写入 storage");
assert.doesNotMatch(app, /console\.(log|info|debug)/, "不得把认证信息写入控制台");
assert.match(index, /id="adminTabButton" hidden/, "管理员入口默认必须隐藏");
assert.match(index, /id="createdKeyPanel" hidden/, "完整 Key 展示区默认必须隐藏");
assert.match(loginHtml, /autocomplete="current-password"/, "密码输入应使用正确 autocomplete");
assert.match(app, /user\.active\s*!==\s*false/, "用户列表必须兼容后端 active 启停字段");

const ids = [...index.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = [...new Set(ids.filter((id, indexAt) => ids.indexOf(id) !== indexAt))];
assert.deepEqual(duplicateIds, [], `index.html 存在重复 id: ${duplicateIds.join(", ")}`);

const referencedIds = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds.filter((id) => !ids.includes(id)))];
assert.deepEqual(missingIds, [], `app.js 引用了不存在的 DOM id: ${missingIds.join(", ")}`);

console.log("auth_ui_static_test: PASS");
