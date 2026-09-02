"""LensGo 模拟数据发布器。

模块划分：
    config.py     运行配置与拥挤度分级规则、.env 读取
    geo.py        WGS-84 → GCJ-02 坐标转换
    amap.py       高德 Web 服务客户端（Key 只在服务端使用）
    db.py         SQLite 连接、表结构与增量迁移
    store.py      全部数据访问逻辑（换 Web 框架时唯一要保留的部分）
    auth.py       读写令牌与本机白名单
    api.py        标准库 HTTP 服务 + 路由
    seed_data.py  内置城市 / 区 / 街道 / 景点
    bus_seed_data.py  内置澳门巴士演示路线 / 站点

版本历史见 versions/ 目录；这里是全项目唯一的版本号来源。
"""

__version__ = "1.2.0"
