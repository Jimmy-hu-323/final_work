const CSRF_STORAGE_KEY = "crowd_csrf_token";

const form = document.getElementById("loginForm");
const button = document.getElementById("loginBtn");
const errorBox = document.getElementById("loginError");

function safeNext() {
  const raw = new URLSearchParams(window.location.search).get("next") || "/";
  try {
    const target = new URL(raw, window.location.origin);
    if (target.origin === window.location.origin && target.pathname !== "/login.html") {
      return `${target.pathname}${target.search}${target.hash}`;
    }
  } catch {
    // 非法 next 参数回到首页。
  }
  return "/";
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`服务器响应格式错误（HTTP ${response.status}）`);
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function alreadyLoggedIn() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "include" });
    if (!response.ok) return;
    const payload = await readJson(response);
    if (payload.csrf_token) {
      sessionStorage.setItem(CSRF_STORAGE_KEY, payload.csrf_token);
    }
    window.location.replace(safeNext());
  } catch {
    // 服务暂不可用时仍保留登录表单，让用户主动重试并看到明确错误。
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = "正在登录…";

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      const message = response.status === 429
        ? "登录尝试过于频繁，请稍后再试。"
        : payload.error || payload.message || "用户名或密码错误。";
      throw new Error(message);
    }
    if (!payload.user || !payload.csrf_token) {
      throw new Error("登录响应缺少用户资料或安全令牌，请联系管理员。 ");
    }
    sessionStorage.setItem(CSRF_STORAGE_KEY, payload.csrf_token);
    window.location.replace(safeNext());
  } catch (error) {
    showError(error.message || "暂时无法登录，请稍后重试。");
    button.disabled = false;
    button.textContent = "登录发布平台";
  }
});

alreadyLoggedIn();
