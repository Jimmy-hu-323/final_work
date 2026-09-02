"""澳门巴士演示路线。

这些路线和坐标只用于 LensGo 功能演示，不是交通事务局实时数据，也不应作为
实际乘车依据。坐标以 WGS-84 编写，入库时统一转换为 GCJ-02。
"""

from __future__ import annotations


ROUTES = [
    {
        "route_id": "macau-bus-61-qingmao-border-gate",
        "route_no": "61",
        "direction": "红街市 → 关闸",
        "origin": "红街市",
        "destination": "关闸总站",
        "operator": "澳门巴士（演示）",
        "color": "#7c3aed",
        "stops": [
            ("macao-stop-red-market", "红街市", 113.5452, 22.2075, 0),
            ("macao-stop-qingmao-ho-yin", "青茂／何贤绅士马路", 113.5420, 22.2101, 3),
            ("macao-stop-ilha-verde", "青洲坊", 113.5376, 22.2126, 7),
            ("macao-stop-canidrome", "看台街", 113.5466, 22.2122, 11),
            ("macao-stop-border-gate", "关闸总站", 113.5491, 22.2141, 15),
        ],
    },
    {
        "route_id": "macau-bus-3a-barra-border-gate",
        "route_no": "3A",
        "direction": "妈阁 → 关闸",
        "origin": "妈阁交通枢纽",
        "destination": "关闸总站",
        "operator": "澳门巴士（演示）",
        "color": "#2563eb",
        "stops": [
            ("macao-stop-barra", "妈阁交通枢纽", 113.5319, 22.1866, 0),
            ("macao-stop-kiang-wu", "河边新街／凯泉湾", 113.5340, 22.1904, 4),
            ("macao-stop-almeida-ribeiro", "新马路／永亨", 113.5408, 22.1933, 8),
            ("macao-stop-ruins-st-paul", "白鸽巢前地", 113.5386, 22.1990, 13),
            ("macao-stop-red-market", "红街市", 113.5452, 22.2075, 18),
            ("macao-stop-border-gate", "关闸总站", 113.5491, 22.2141, 24),
        ],
    },
    {
        "route_id": "macau-bus-18-portas-hac-sa",
        "route_no": "18",
        "direction": "关闸 → 路环市区",
        "origin": "关闸总站",
        "destination": "路环街市",
        "operator": "澳门巴士（演示）",
        "color": "#16a34a",
        "stops": [
            ("macao-stop-border-gate", "关闸总站", 113.5491, 22.2141, 0),
            ("macao-stop-red-market", "红街市", 113.5452, 22.2075, 5),
            ("macao-stop-almeida-ribeiro", "新马路／永亨", 113.5408, 22.1933, 11),
            ("macao-stop-ferreira-amaral", "亚马喇前地", 113.5497, 22.1907, 16),
            ("macao-stop-taipa-village", "氹仔官也街", 113.5564, 22.1541, 27),
            ("macao-stop-cotai-central", "路氹连贯公路", 113.5684, 22.1468, 34),
            ("macao-stop-coloane-market", "路环街市", 113.5560, 22.1165, 45),
        ],
    },
    {
        "route_id": "macau-bus-26a-gongbei-hac-sa",
        "route_no": "26A",
        "direction": "筷子基北湾 → 黑沙海滩",
        "origin": "筷子基北湾",
        "destination": "黑沙海滩",
        "operator": "澳门巴士（演示）",
        "color": "#ea580c",
        "stops": [
            ("macao-stop-fai-chi-kei", "筷子基北湾", 113.5387, 22.2090, 0),
            ("macao-stop-red-market", "红街市", 113.5452, 22.2075, 5),
            ("macao-stop-ferreira-amaral", "亚马喇前地", 113.5497, 22.1907, 12),
            ("macao-stop-taipa-village", "氹仔官也街", 113.5564, 22.1541, 23),
            ("macao-stop-cotai-central", "路氹连贯公路", 113.5684, 22.1468, 30),
            ("macao-stop-coloane-market", "路环街市", 113.5560, 22.1165, 41),
            ("macao-stop-hac-sa", "黑沙海滩", 113.5755, 22.1184, 50),
        ],
    },
]
