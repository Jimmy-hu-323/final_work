# data_publish 前端

这里保存澳门人流数据发布器的完整静态前端：

```text
web/
├─ index.html
├─ app.js
├─ styles.css
└─ vendor/       本地 Leaflet 资源
```

前端没有框架和构建步骤，但会调用同源 `/api/*`。请使用后端服务托管它，不要直接双击 `index.html`：

```powershell
cd Z:\qwen_compitition\final_work\project_backend\middle_stage\data_publish
python run.py --host 127.0.0.1 --port 18099
```

然后访问 `http://127.0.0.1:18099/`。

本副本未包含 `.env`、高德 Key、SQLite 数据库、历史备份或 Python 后端代码。
