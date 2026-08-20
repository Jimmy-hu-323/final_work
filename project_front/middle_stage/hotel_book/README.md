# hotel_book 前端

这里是酒店搜索、预订、账单、调整和付款授权界面的前端源码副本。

## 保留内容

- `app/hotel-app.tsx`：主要 React 界面与交互
- `app/globals.css`、`layout.tsx`、`page.tsx`
- `public/` 静态资源
- Vinext/Vite/Next/PostCSS/TypeScript/ESLint 构建配置
- Cloudflare 前端运行入口与静态入口生成脚本
- 前端渲染测试

## 后端依赖

界面通过同源 `/api/v1/*` 请求酒店、库存、预订、账单和付款授权数据。本目录不复制 `app/api` 与服务端数据层；联调时请启动：

```text
Z:\qwen_compitition\final_work\project_backend\middle_stage\hotel_book
```

本地默认服务地址是 `http://127.0.0.1:18110`。如果单独托管此前端，需要由反向代理把 `/api/v1/*` 转发到该后端。

## 安装与检查

```powershell
npm ci
npm run build
npm run lint
```

未复制 `.dev.vars`、服务 Token、数据库、`node_modules`、构建产物、运行日志和恢复备份。
