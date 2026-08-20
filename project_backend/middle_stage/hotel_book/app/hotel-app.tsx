"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Hotel = {
  id: string;
  name: string;
  area: string;
  address: string;
  stars: number;
  rating: number;
  description: string;
  accent: "jade" | "sand" | "coral";
  distance: string;
  amenities: string[];
  roomName: string;
  price: number;
  availableRooms: number;
};

type Breakdown = { label: string; amount: number };

type Bill = {
  id: string;
  booking_id: string;
  title: string;
  subtitle: string;
  amount: number;
  currency: string;
  status: "PENDING_PAYMENT" | "PROCESSING" | "PAID" | "REFUNDED";
  due_at: string;
  version: number;
  breakdown: Breakdown[];
  confirmation_no: string;
};

type Authorization = {
  id: string;
  agent_name: string;
  bill_ids: string[];
  max_amount: number;
  currency: string;
  status: "PENDING" | "GRANTED";
  expires_at: string;
};

type Activity = {
  id: string;
  kind: string;
  message: string;
  created_at: string;
};

type Inventory = {
  hotel_id: string;
  hotel_name: string;
  stay_date: string;
  room_name: string;
  price: number;
  available_rooms: number;
  status: string;
};

type AppState = {
  user: { id: string; display_name: string };
  query: { check_in: string; check_out: string };
  hotels: Hotel[];
  bills: Bill[];
  authorizations: Authorization[];
  activities: Activity[];
};

type Toast = { tone: "success" | "error" | "info"; message: string } | null;

const money = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 0,
  }).format(value / 100);

const shortDate = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", weekday: "short" }).format(
    new Date(`${value}T00:00:00`),
  );

const todayOffset = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

async function jsonRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "操作未完成，请稍后重试");
  return payload;
}

function StatusPill({ status }: { status: Bill["status"] }) {
  const labels: Record<Bill["status"], string> = {
    PENDING_PAYMENT: "待支付",
    PROCESSING: "处理中",
    PAID: "已支付",
    REFUNDED: "已退款",
  };
  return <span className={`status-pill status-${status.toLowerCase()}`}>{labels[status]}</span>;
}

function CityArtwork({ accent, name }: { accent: Hotel["accent"]; name: string }) {
  return (
    <div className={`city-art city-${accent}`} role="img" aria-label={`${name} 酒店概念图`}>
      <div className="sun-disc" />
      <div className="sky-line sky-one" />
      <div className="sky-line sky-two" />
      <div className="building building-back">
        <i />
        <i />
        <i />
      </div>
      <div className="building building-front">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="art-label">MACAU · STAY</div>
    </div>
  );
}

export function HotelApp() {
  const [activeView, setActiveView] = useState<"discover" | "bills" | "merchant">("discover");
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [destination, setDestination] = useState("澳门");
  const [checkIn, setCheckIn] = useState(todayOffset(1));
  const [checkOut, setCheckOut] = useState(todayOffset(3));
  const [guests, setGuests] = useState(2);
  const [selectedHotel, setSelectedHotel] = useState<Hotel | null>(null);
  const [selectedBills, setSelectedBills] = useState<string[]>([]);
  const [adjustBill, setAdjustBill] = useState<Bill | null>(null);
  const [breakfast, setBreakfast] = useState(false);
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);

  const notify = (message: string, tone: Toast["tone"] = "info") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4200);
  };

  const loadState = useCallback(
    async (nextCheckIn = checkIn, nextCheckOut = checkOut) => {
      const data = await jsonRequest<AppState>(
        `/api/v1/state?check_in=${encodeURIComponent(nextCheckIn)}&check_out=${encodeURIComponent(nextCheckOut)}`,
      );
      setState(data);
      setSelectedBills((current) =>
        current.filter((id) =>
          data.bills.some((bill) => bill.id === id && bill.status === "PENDING_PAYMENT"),
        ),
      );
    },
    [checkIn, checkOut],
  );

  useEffect(() => {
    loadState()
      .catch((error: Error) => notify(error.message, "error"))
      .finally(() => setLoading(false));
  }, [loadState]);

  const loadInventory = useCallback(async () => {
    setInventoryLoading(true);
    try {
      const data = await jsonRequest<{ data: Inventory[] }>("/api/v1/inventory?hotel_id=hotel_harbour");
      setInventory(data.data);
    } catch (error) {
      notify(error instanceof Error ? error.message : "库存加载失败", "error");
    } finally {
      setInventoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === "merchant" && !inventory.length) void loadInventory();
  }, [activeView, inventory.length, loadInventory]);

  const pendingBills = useMemo(
    () => state?.bills.filter((bill) => bill.status === "PENDING_PAYMENT") || [],
    [state],
  );
  const outstanding = pendingBills.reduce((sum, bill) => sum + bill.amount, 0);
  const selectedTotal = pendingBills
    .filter((bill) => selectedBills.includes(bill.id))
    .reduce((sum, bill) => sum + bill.amount, 0);
  const pendingAuthorization = state?.authorizations.find((auth) => auth.status === "PENDING");
  const grantedAuthorization = state?.authorizations.find((auth) => auth.status === "GRANTED");

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (Date.parse(checkOut) <= Date.parse(checkIn)) {
      notify("离店日期必须晚于入住日期", "error");
      return;
    }
    setBusy(true);
    try {
      await loadState(checkIn, checkOut);
      notify(`已更新 ${destination} 的实时可订房`, "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "搜索失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createBooking() {
    if (!selectedHotel) return;
    setBusy(true);
    try {
      const response = await jsonRequest<{ bill: { id: string } }>("/api/v1/bookings", {
        method: "POST",
        body: JSON.stringify({
          hotel_id: selectedHotel.id,
          check_in: checkIn,
          check_out: checkOut,
          guests,
          rooms: 1,
        }),
      });
      setSelectedHotel(null);
      await loadState();
      setSelectedBills([response.bill.id]);
      setActiveView("bills");
      notify("房间已保留 10 分钟，账单已加入账单中心", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建订单失败", "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleBill(id: string) {
    setSelectedBills((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function applyAdjustment() {
    if (!adjustBill) return;
    setBusy(true);
    try {
      await jsonRequest("/api/v1/bills", {
        method: "POST",
        body: JSON.stringify({ action: "adjust", bill_id: adjustBill.id, breakfast }),
      });
      setAdjustBill(null);
      await loadState();
      notify("账单已重新报价，旧的 AI 付款授权已失效", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "账单调整失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function requestAuthorization() {
    if (!selectedBills.length) {
      notify("请先选择需要授权的账单", "error");
      return;
    }
    setBusy(true);
    try {
      await jsonRequest("/api/v1/payment-authorizations", {
        method: "POST",
        body: JSON.stringify({
          action: "request",
          bill_ids: selectedBills,
          agent_name: "LensGo 旅行助手",
        }),
      });
      await loadState();
      notify("AI 授权请求已发送，等待你确认", "info");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法发起授权", "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateAuthorization(action: "grant" | "revoke", authorizationId: string) {
    setBusy(true);
    try {
      await jsonRequest("/api/v1/payment-authorizations", {
        method: "POST",
        body: JSON.stringify({ action, authorization_id: authorizationId }),
      });
      await loadState();
      notify(action === "grant" ? "已授予一次性付款权限，有效期 5 分钟" : "已拒绝付款授权", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "授权操作失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function pay(actor: "user" | "ai") {
    if (!selectedBills.length) {
      notify("请先选择需要支付的账单", "error");
      return;
    }
    setBusy(true);
    try {
      await jsonRequest("/api/v1/payment-sessions", {
        method: "POST",
        body: JSON.stringify({
          actor,
          bill_ids: selectedBills,
          authorization_id: actor === "ai" ? grantedAuthorization?.id : undefined,
        }),
      });
      setSelectedBills([]);
      await loadState();
      notify(actor === "ai" ? "AI 已使用一次性授权完成模拟付款" : "模拟付款成功，订单已确认", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "付款失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateInventory(row: Inventory, changes: Partial<Inventory>) {
    const next = { ...row, ...changes };
    setInventory((current) =>
      current.map((item) =>
        item.hotel_id === row.hotel_id && item.stay_date === row.stay_date ? next : item,
      ),
    );
    try {
      await jsonRequest("/api/v1/inventory", {
        method: "PUT",
        body: JSON.stringify({
          hotel_id: next.hotel_id,
          stay_date: next.stay_date,
          price: next.price,
          available_rooms: next.available_rooms,
        }),
      });
      notify(`${shortDate(next.stay_date)} 的价格库存已保存`, "success");
    } catch (error) {
      setInventory((current) =>
        current.map((item) =>
          item.hotel_id === row.hotel_id && item.stay_date === row.stay_date ? row : item,
        ),
      );
      notify(error instanceof Error ? error.message : "库存保存失败", "error");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setActiveView("discover")} aria-label="返回首页">
          <span className="brand-mark">旅</span>
          <span>
            <strong>旅屿</strong>
            <small>STAY WITH CLARITY</small>
          </span>
        </button>
        <nav className="desktop-nav" aria-label="主导航">
          <button className={activeView === "discover" ? "active" : ""} onClick={() => setActiveView("discover")}>
            找酒店
          </button>
          <button className={activeView === "bills" ? "active" : ""} onClick={() => setActiveView("bills")}>
            账单
            {pendingBills.length > 0 && <span className="nav-count">{pendingBills.length}</span>}
          </button>
          <button className={activeView === "merchant" ? "active" : ""} onClick={() => setActiveView("merchant")}>
            酒店工作台
          </button>
        </nav>
        <div className="header-actions">
          <a className="api-link" href="/api/v1/openapi" target="_blank" rel="noreferrer">
            API
          </a>
          <div className="profile">
            <span>{state?.user.display_name?.slice(0, 1) || "林"}</span>
            <div>
              <strong>{state?.user.display_name || "林澄"}</strong>
              <small>旅行者</small>
            </div>
          </div>
        </div>
      </header>

      <div className="trust-strip">
        <span className="trust-dot" />
        <p>
          <strong>AI 可以帮你找房和整理账单</strong>
          <span>付款权限默认关闭，只有你能授予。</span>
        </p>
        <button type="button" onClick={() => setActiveView("bills")}>
          查看权限
        </button>
      </div>

      {loading ? (
        <section className="loading-state" role="status">
          <div className="loading-mark">旅</div>
          <p>正在整理实时价格与账单…</p>
        </section>
      ) : (
        <>
          {activeView === "discover" && (
            <div className="page discover-page">
              <section className="hero">
                <div className="hero-copy">
                  <span className="eyebrow">AI-NATIVE HOTEL BOOKING</span>
                  <h1>
                    把住宿订得
                    <br />
                    <em>清楚，也从容。</em>
                  </h1>
                  <p>真实库存、完整价格与明确授权。你负责决定，AI 负责把复杂的旅程整理好。</p>
                </div>
                <div className="hero-orbit" aria-hidden="true">
                  <span className="orbit-label label-one">实时报价</span>
                  <span className="orbit-label label-two">库存锁定</span>
                  <span className="orbit-label label-three">用户付款</span>
                  <div className="orbit-core">
                    <span>AI</span>
                    <small>已连接</small>
                  </div>
                </div>
              </section>

              <form className="search-panel" onSubmit={handleSearch}>
                <label className="search-field destination-field">
                  <span>目的地</span>
                  <input value={destination} onChange={(event) => setDestination(event.target.value)} aria-label="目的地" />
                  <small>澳门特别行政区</small>
                </label>
                <label className="search-field">
                  <span>入住</span>
                  <input type="date" value={checkIn} min={todayOffset(1)} onChange={(event) => setCheckIn(event.target.value)} aria-label="入住日期" />
                  <small>{shortDate(checkIn)}</small>
                </label>
                <label className="search-field">
                  <span>离店</span>
                  <input type="date" value={checkOut} min={checkIn} onChange={(event) => setCheckOut(event.target.value)} aria-label="离店日期" />
                  <small>{shortDate(checkOut)}</small>
                </label>
                <label className="search-field">
                  <span>住客</span>
                  <select value={guests} onChange={(event) => setGuests(Number(event.target.value))} aria-label="住客人数">
                    <option value={1}>1 位成人</option>
                    <option value={2}>2 位成人</option>
                    <option value={3}>3 位住客</option>
                    <option value={4}>4 位住客</option>
                  </select>
                  <small>1 间客房</small>
                </label>
                <button className="search-button" type="submit" disabled={busy}>
                  <span>搜索可订酒店</span>
                  <b>↗</b>
                </button>
              </form>

              <section className="section hotels-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">LIVE AVAILABILITY</span>
                    <h2>现在可订的好住处</h2>
                  </div>
                  <p>
                    {state?.hotels.length || 0} 家匹配 · {shortDate(checkIn)} — {shortDate(checkOut)}
                  </p>
                </div>
                <div className="hotel-grid">
                  {state?.hotels.map((hotel, index) => (
                    <article className="hotel-card" key={hotel.id}>
                      <div className="hotel-art-wrap">
                        <CityArtwork accent={hotel.accent} name={hotel.name} />
                        <span className="card-number">0{index + 1}</span>
                        <span className="rating-badge">★ {hotel.rating.toFixed(1)}</span>
                      </div>
                      <div className="hotel-card-body">
                        <div className="hotel-title-row">
                          <div>
                            <span>{hotel.area} · {hotel.stars} 星</span>
                            <h3>{hotel.name}</h3>
                          </div>
                          <div className="hotel-price">
                            <strong>{money(hotel.price)}</strong>
                            <small>本次入住</small>
                          </div>
                        </div>
                        <p className="hotel-description">{hotel.description}</p>
                        <div className="amenity-row">
                          {hotel.amenities.slice(0, 3).map((amenity) => (
                            <span key={amenity}>{amenity}</span>
                          ))}
                        </div>
                        <div className="availability-row">
                          <span className="availability-dot" />
                          仅剩 {hotel.availableRooms} 间 · {hotel.roomName}
                        </div>
                        <button className="book-button" type="button" onClick={() => setSelectedHotel(hotel)}>
                          查看并生成账单
                          <span>→</span>
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="ai-explainer">
                <div>
                  <span className="eyebrow">BUILT FOR HUMANS & AGENTS</span>
                  <h2>AI 能做很多事，<br />但不能替你花钱。</h2>
                </div>
                <div className="explain-steps">
                  <div><b>01</b><p><strong>搜索与比较</strong><span>AI 读取结构化价格、库存和政策，不猜测页面内容。</span></p></div>
                  <div><b>02</b><p><strong>整理统一账单</strong><span>房费、服务费和附加项目集中展示，修改后重新报价。</span></p></div>
                  <div><b>03</b><p><strong>由你确认付款</strong><span>默认由你直接支付；AI 代理支付需要一次性限额授权。</span></p></div>
                </div>
              </section>
            </div>
          )}

          {activeView === "bills" && (
            <div className="page bills-page">
              <section className="page-title-row">
                <div>
                  <span className="eyebrow">ONE CLEAR PLACE TO PAY</span>
                  <h1>我的账单</h1>
                  <p>调整、授权和付款都在这里完成。每次金额变化都会产生新的账单版本。</p>
                </div>
                <div className="summary-card">
                  <span>待支付总额</span>
                  <strong>{money(outstanding)}</strong>
                  <small>{pendingBills.length} 笔账单等待处理</small>
                </div>
              </section>

              {pendingAuthorization && (
                <section className="authorization-card pending-auth">
                  <div className="auth-icon">AI</div>
                  <div className="auth-copy">
                    <span className="eyebrow">PAYMENT PERMISSION REQUEST</span>
                    <h3>{pendingAuthorization.agent_name} 请求付款权限</h3>
                    <p>
                      仅限 {pendingAuthorization.bill_ids.length} 笔账单，最高 {money(pendingAuthorization.max_amount)}，
                      授权后 5 分钟内仅可使用一次。
                    </p>
                  </div>
                  <div className="auth-actions">
                    <button className="text-button" type="button" disabled={busy} onClick={() => updateAuthorization("revoke", pendingAuthorization.id)}>
                      拒绝
                    </button>
                    <button className="primary-button" type="button" disabled={busy} onClick={() => updateAuthorization("grant", pendingAuthorization.id)}>
                      授予一次权限
                    </button>
                  </div>
                </section>
              )}

              {grantedAuthorization && (
                <section className="authorization-card granted-auth">
                  <div className="auth-icon">✓</div>
                  <div className="auth-copy">
                    <span className="eyebrow">ONE-TIME ACCESS GRANTED</span>
                    <h3>AI 已获得一次性付款权限</h3>
                    <p>仅适用于已确认的账单版本，金额或账单变化会立即使权限失效。</p>
                  </div>
                  <button className="primary-button" type="button" disabled={busy} onClick={() => pay("ai")}>
                    让 AI 使用授权付款
                  </button>
                </section>
              )}

              <div className="bill-layout">
                <section className="bill-list">
                  <div className="list-toolbar">
                    <div className="filter-pills">
                      <button className="active" type="button">全部</button>
                      <button type="button">待支付 {pendingBills.length}</button>
                      <button type="button">已支付</button>
                    </div>
                    <button className="select-all" type="button" onClick={() => setSelectedBills(selectedBills.length === pendingBills.length ? [] : pendingBills.map((bill) => bill.id))}>
                      {selectedBills.length === pendingBills.length && pendingBills.length ? "取消全选" : "选择全部待付"}
                    </button>
                  </div>

                  {state?.bills.map((bill) => {
                    const pending = bill.status === "PENDING_PAYMENT";
                    const selected = selectedBills.includes(bill.id);
                    return (
                      <article className={`bill-card ${selected ? "selected" : ""}`} key={bill.id}>
                        <div className="bill-select">
                          <label className="check-control">
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!pending}
                              onChange={() => toggleBill(bill.id)}
                              aria-label={`选择 ${bill.title} 账单`}
                            />
                            <span />
                          </label>
                        </div>
                        <div className="bill-main">
                          <div className="bill-heading">
                            <div>
                              <span className="bill-kicker">酒店预订 · {bill.confirmation_no}</span>
                              <h3>{bill.title}</h3>
                              <p>{bill.subtitle}</p>
                            </div>
                            <div className="bill-amount">
                              <StatusPill status={bill.status} />
                              <strong>{money(bill.amount)}</strong>
                              <small>账单版本 v{bill.version}</small>
                            </div>
                          </div>
                          <div className="bill-breakdown">
                            {bill.breakdown.map((item) => (
                              <div key={item.label}>
                                <span>{item.label}</span>
                                <b>{money(item.amount)}</b>
                              </div>
                            ))}
                          </div>
                          <div className="bill-footer">
                            <div>
                              {pending ? (
                                <span className="deadline">请在 {new Date(bill.due_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前付款</span>
                              ) : (
                                <span className="paid-note">付款凭证已归档</span>
                              )}
                            </div>
                            <div>
                              <button className="text-button" type="button">查看时间线</button>
                              {pending && (
                                <button
                                  className="outline-button"
                                  type="button"
                                  onClick={() => {
                                    setAdjustBill(bill);
                                    setBreakfast(bill.breakdown.some((item) => item.label === "双人早餐"));
                                  }}
                                >
                                  调整账单
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </section>

                <aside className="checkout-panel">
                  <span className="eyebrow">PAYMENT SUMMARY</span>
                  <h3>付款确认</h3>
                  <div className="checkout-line">
                    <span>已选账单</span>
                    <b>{selectedBills.length} 笔</b>
                  </div>
                  <div className="checkout-line">
                    <span>币种</span>
                    <b>CNY</b>
                  </div>
                  <div className="checkout-total">
                    <span>应付总额</span>
                    <strong>{money(selectedTotal)}</strong>
                  </div>
                  <button className="pay-button" type="button" disabled={!selectedBills.length || busy} onClick={() => pay("user")}>
                    由我确认并付款
                  </button>
                  <button className="ai-auth-button" type="button" disabled={!selectedBills.length || busy} onClick={requestAuthorization}>
                    请求 AI 一次性付款权限
                  </button>
                  <p className="checkout-hint">
                    <span>⌁</span>
                    这是安全模拟支付，不会产生真实扣款。接入支付机构后，仍以服务端回调为准。
                  </p>
                  <div className="security-note">
                    <b>AI 当前权限</b>
                    <span className={grantedAuthorization ? "permission-on" : "permission-off"}>
                      {grantedAuthorization ? "一次性已开启" : "付款权限关闭"}
                    </span>
                  </div>
                </aside>
              </div>

              <section className="activity-section">
                <div className="section-heading compact">
                  <div><span className="eyebrow">AUDIT TRAIL</span><h2>最近活动</h2></div>
                  <span>所有授权与付款操作都有记录</span>
                </div>
                <div className="activity-grid">
                  {state?.activities.slice(0, 4).map((activity) => (
                    <div className="activity-item" key={activity.id}>
                      <span className={`activity-kind kind-${activity.kind.toLowerCase()}`}>{activity.kind.slice(0, 2)}</span>
                      <p><strong>{activity.message}</strong><small>{new Date(activity.created_at).toLocaleString("zh-CN")}</small></p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {activeView === "merchant" && (
            <div className="page merchant-page">
              <section className="page-title-row merchant-title">
                <div>
                  <span className="eyebrow">HOTEL OPERATIONS</span>
                  <h1>酒店工作台</h1>
                  <p>维护每日价格和可售房量。每次修改都会立即成为用户与 AI 搜索时的唯一可信数据。</p>
                </div>
                <div className="merchant-badge">
                  <span>酒店</span>
                  <strong>澄湾艺居</strong>
                  <small>已审核 · 正常营业</small>
                </div>
              </section>
              <section className="merchant-stats">
                <div><span>未来 14 天可售</span><strong>{inventory.reduce((sum, row) => sum + row.available_rooms, 0)}</strong><small>间夜</small></div>
                <div><span>平均房价</span><strong>{money(inventory.length ? inventory.reduce((sum, row) => sum + row.price, 0) / inventory.length : 0)}</strong><small>每晚</small></div>
                <div><span>低库存日期</span><strong>{inventory.filter((row) => row.available_rooms <= 2).length}</strong><small>需关注</small></div>
                <div><span>渠道状态</span><strong className="online-text">在线</strong><small>用户与 AI 均可订</small></div>
              </section>
              <section className="inventory-section">
                <div className="section-heading compact">
                  <div><span className="eyebrow">RATE & INVENTORY</span><h2>价格库存日历</h2></div>
                  <p>点击数量调整库存，修改价格后离开输入框自动保存。</p>
                </div>
                {inventoryLoading ? (
                  <div className="inventory-loading">正在读取实时库存…</div>
                ) : (
                  <div className="inventory-table-wrap">
                    <table className="inventory-table">
                      <thead>
                        <tr><th>日期</th><th>房型</th><th>可售房量</th><th>当日价格</th><th>销售状态</th></tr>
                      </thead>
                      <tbody>
                        {inventory.map((row) => (
                          <tr key={`${row.hotel_id}-${row.stay_date}`}>
                            <td><strong>{shortDate(row.stay_date)}</strong><small>{row.stay_date}</small></td>
                            <td>{row.room_name}</td>
                            <td>
                              <div className="stepper">
                                <button type="button" aria-label="减少库存" onClick={() => updateInventory(row, { available_rooms: Math.max(0, row.available_rooms - 1) })}>−</button>
                                <b className={row.available_rooms <= 2 ? "low-stock" : ""}>{row.available_rooms}</b>
                                <button type="button" aria-label="增加库存" onClick={() => updateInventory(row, { available_rooms: row.available_rooms + 1 })}>＋</button>
                              </div>
                            </td>
                            <td>
                              <label className="price-input">
                                <span>¥</span>
                                <input
                                  aria-label={`${row.stay_date} 价格`}
                                  type="number"
                                  value={Math.round(row.price / 100)}
                                  onChange={(event) =>
                                    setInventory((current) =>
                                      current.map((item) =>
                                        item.hotel_id === row.hotel_id && item.stay_date === row.stay_date
                                          ? { ...item, price: Number(event.target.value) * 100 }
                                          : item,
                                      ),
                                    )
                                  }
                                  onBlur={(event) => updateInventory(row, { price: Number(event.target.value) * 100 })}
                                />
                              </label>
                            </td>
                            <td><span className="open-status"><i />开放预订</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}

      <nav className="mobile-nav" aria-label="移动端主导航">
        <button className={activeView === "discover" ? "active" : ""} onClick={() => setActiveView("discover")}>
          <span>⌂</span>找酒店
        </button>
        <button className={activeView === "bills" ? "active" : ""} onClick={() => setActiveView("bills")}>
          <span>▤</span>账单{pendingBills.length > 0 && <i>{pendingBills.length}</i>}
        </button>
        <button className={activeView === "merchant" ? "active" : ""} onClick={() => setActiveView("merchant")}>
          <span>□</span>酒店端
        </button>
      </nav>

      {selectedHotel && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedHotel(null)}>
          <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-title">
            <button className="modal-close" type="button" aria-label="关闭" onClick={() => setSelectedHotel(null)}>×</button>
            <CityArtwork accent={selectedHotel.accent} name={selectedHotel.name} />
            <div className="modal-content">
              <span className="eyebrow">REAL-TIME QUOTE</span>
              <h2 id="booking-title">{selectedHotel.name}</h2>
              <p>{selectedHotel.roomName} · {guests} 位住客 · 1 间</p>
              <div className="modal-dates">
                <div><span>入住</span><strong>{shortDate(checkIn)}</strong></div>
                <b>→</b>
                <div><span>离店</span><strong>{shortDate(checkOut)}</strong></div>
              </div>
              <div className="modal-policy">
                <span>✓ 10 分钟库存保留</span>
                <span>✓ 付款前可调整</span>
                <span>✓ AI 无付款权限</span>
              </div>
              <div className="modal-total">
                <div><span>含税总价</span><small>最终金额以新账单为准</small></div>
                <strong>{money(Math.round(selectedHotel.price * 1.1))}</strong>
              </div>
              <button className="pay-button" type="button" disabled={busy} onClick={createBooking}>
                确认并生成待支付账单
              </button>
            </div>
          </section>
        </div>
      )}

      {adjustBill && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setAdjustBill(null)}>
          <section className="adjust-modal" role="dialog" aria-modal="true" aria-labelledby="adjust-title">
            <button className="modal-close" type="button" aria-label="关闭" onClick={() => setAdjustBill(null)}>×</button>
            <span className="eyebrow">BILL ADJUSTMENT</span>
            <h2 id="adjust-title">调整账单</h2>
            <p>金额不能直接编辑。选择服务后，系统会生成新的报价和账单版本。</p>
            <label className={`service-option ${breakfast ? "selected" : ""}`}>
              <input type="checkbox" checked={breakfast} onChange={(event) => setBreakfast(event.target.checked)} />
              <span className="service-check">{breakfast ? "✓" : ""}</span>
              <span><strong>双人早餐</strong><small>入住期间每日早餐</small></span>
              <b>+ ¥180</b>
            </label>
            <div className="adjust-total">
              <span>调整后预计总额</span>
              <strong>{money(adjustBill.amount + (breakfast && !adjustBill.breakdown.some((item) => item.label === "双人早餐") ? 18000 : !breakfast && adjustBill.breakdown.some((item) => item.label === "双人早餐") ? -18000 : 0))}</strong>
            </div>
            <div className="warning-note">账单版本变化后，已有 AI 付款授权会立即失效。</div>
            <button className="pay-button" type="button" disabled={busy} onClick={applyAdjustment}>
              重新报价并保存
            </button>
          </section>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}</span>{toast.message}</div>}
    </main>
  );
}
