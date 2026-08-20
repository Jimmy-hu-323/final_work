import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Modal,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import {
  Bot,
  CheckCircle2,
  CreditCard,
  RefreshCw,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import {
  confirmHotelBillAdjustment,
  listHotelBills,
  listHotelPaymentAuthorizations,
  payHotelBills,
  previewHotelBillAdjustment,
  updateHotelPaymentAuthorization,
  type HotelAdjustmentPreview,
  type HotelBill,
  type HotelPaymentAuthorization,
} from "./runtime";
import styles from "./mobileLocal.module.less";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "操作失败");
}

function money(amount: number, currency = "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
  }).format(amount / 100);
}

export default function HotelBillsPage() {
  const [bills, setBills] = useState<HotelBill[]>([]);
  const [authorizations, setAuthorizations] = useState<
    HotelPaymentAuthorization[]
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [breakfastByBill, setBreakfastByBill] = useState<
    Record<string, boolean>
  >({});
  const [previewByBill, setPreviewByBill] = useState<
    Record<string, HotelAdjustmentPreview | undefined>
  >({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextBills, nextAuthorizations] = await Promise.all([
        listHotelBills(),
        listHotelPaymentAuthorizations(),
      ]);
      setBills(nextBills);
      setAuthorizations(nextAuthorizations);
      const payableIds = new Set(
        nextBills
          .filter((item) => item.status === "PENDING_PAYMENT")
          .map((item) => item.id),
      );
      setSelected((current) => current.filter((id) => payableIds.has(id)));
      setBreakfastByBill(
        Object.fromEntries(
          nextBills.map((bill) => [
            bill.id,
            bill.breakdown.some((item) => item.label === "双人早餐"),
          ]),
        ),
      );
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pendingBills = bills.filter(
    (item) => item.status === "PENDING_PAYMENT",
  );
  const selectedBills = bills.filter((item) => selected.includes(item.id));
  const selectedAmount = selectedBills.reduce(
    (sum, item) => sum + item.amount,
    0,
  );
  const pendingAuthorizations = authorizations.filter(
    (item) => item.status === "PENDING",
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const previewAdjustment = async (bill: HotelBill) => {
    setWorking(`preview:${bill.id}`);
    try {
      const preview = await previewHotelBillAdjustment(
        bill.id,
        Boolean(breakfastByBill[bill.id]),
      );
      setPreviewByBill((current) => ({ ...current, [bill.id]: preview }));
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setWorking("");
    }
  };

  const confirmAdjustment = async (bill: HotelBill) => {
    const preview = previewByBill[bill.id];
    if (!preview) return;
    setWorking(`confirm:${bill.id}`);
    try {
      await confirmHotelBillAdjustment(bill.id, preview.id);
      message.success("账单调整已确认，旧付款授权已自动失效");
      setPreviewByBill((current) => ({ ...current, [bill.id]: undefined }));
      await refresh();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setWorking("");
    }
  };

  const paySelected = () => {
    if (!selected.length) {
      message.warning("请先选择待支付账单");
      return;
    }
    Modal.confirm({
      title: `确认支付 ${money(selectedAmount)}？`,
      content:
        "这是用户本人付款操作。AI 无法点击确认，也无法在没有一次性授权时替你支付。",
      okText: "由我确认支付",
      cancelText: "取消",
      onOk: async () => {
        setWorking("pay");
        try {
          await payHotelBills(selected);
          message.success("支付成功");
          setSelected([]);
          await refresh();
        } catch (error) {
          message.error(errorText(error));
          throw error;
        } finally {
          setWorking("");
        }
      },
    });
  };

  const resolveAuthorization = async (
    authorization: HotelPaymentAuthorization,
    action: "grant" | "revoke",
  ) => {
    setWorking(`${action}:${authorization.id}`);
    try {
      await updateHotelPaymentAuthorization(action, {
        authorizationId: authorization.id,
      });
      message.success(
        action === "grant" ? "已授予一次性付款权限" : "已拒绝授权",
      );
      await refresh();
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setWorking("");
    }
  };

  return (
    <section className={styles.page}>
      <div className={styles.header}>
        <div>
          <Typography.Title level={3}>酒店账单</Typography.Title>
          <Typography.Text type="secondary">
            最终账单、微调与付款都集中在这里
          </Typography.Text>
        </div>
        <Button
          shape="circle"
          icon={<RefreshCw size={17} />}
          loading={loading}
          onClick={() => void refresh()}
          aria-label="刷新账单"
        />
      </div>

      <Alert
        showIcon
        type="warning"
        message="AI 默认没有付款权限"
        description="AI 可以搜索、报价和创建待支付预订；付款必须由你确认，或由你授予指定账单、指定金额、限时的一次性权限。"
      />

      {pendingAuthorizations.map((authorization) => (
        <Card
          key={authorization.id}
          className={styles.authorizationCard}
          title={
            <Space>
              <Bot size={18} />
              AI 请求一次性付款授权
            </Space>
          }
        >
          <div className={styles.authorizationSummary}>
            <strong>
              {money(authorization.max_amount, authorization.currency)}
            </strong>
            <span>{authorization.bill_ids.length} 笔账单 · 5 分钟内有效</span>
          </div>
          <Space wrap>
            <Button
              type="primary"
              icon={<ShieldCheck size={16} />}
              loading={working === `grant:${authorization.id}`}
              onClick={() => void resolveAuthorization(authorization, "grant")}
            >
              同意一次
            </Button>
            <Button
              danger
              loading={working === `revoke:${authorization.id}`}
              onClick={() => void resolveAuthorization(authorization, "revoke")}
            >
              拒绝
            </Button>
          </Space>
        </Card>
      ))}

      {loading && !bills.length ? (
        <div className={styles.billLoading}>
          <Spin />
        </div>
      ) : bills.length === 0 ? (
        <Card className={styles.card}>
          <Empty description="还没有酒店账单；可在对话中让 AI 搜索并预订酒店" />
        </Card>
      ) : (
        bills.map((bill) => {
          const payable = bill.status === "PENDING_PAYMENT";
          const preview = previewByBill[bill.id];
          return (
            <Card
              key={bill.id}
              className={styles.billCard}
              title={
                <Space>
                  <ReceiptText size={18} />
                  {bill.title}
                </Space>
              }
              extra={
                <Tag
                  color={
                    payable
                      ? "orange"
                      : bill.status === "PAID"
                      ? "green"
                      : "default"
                  }
                >
                  {payable
                    ? "待支付"
                    : bill.status === "PAID"
                    ? "已支付"
                    : bill.status}
                </Tag>
              }
            >
              <div className={styles.billTopline}>
                {payable ? (
                  <Checkbox
                    checked={selectedSet.has(bill.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...new Set([...current, bill.id])]
                          : current.filter((id) => id !== bill.id),
                      )
                    }
                  >
                    选择付款
                  </Checkbox>
                ) : (
                  <Space>
                    <CheckCircle2 size={16} />
                    支付完成
                  </Space>
                )}
                <strong>{money(bill.amount, bill.currency)}</strong>
              </div>
              <Typography.Paragraph
                type="secondary"
                className={styles.billSubtitle}
              >
                {bill.subtitle}
              </Typography.Paragraph>
              <div className={styles.billBreakdown}>
                {bill.breakdown.map((item) => (
                  <div key={`${bill.id}:${item.label}`}>
                    <span>{item.label}</span>
                    <span>{money(item.amount, bill.currency)}</span>
                  </div>
                ))}
              </div>
              <div className={styles.billMeta}>
                <span>账单版本 v{bill.version}</span>
                {bill.confirmation_no ? (
                  <span>预订号 {bill.confirmation_no}</span>
                ) : null}
              </div>

              {payable ? (
                <div className={styles.adjustmentBox}>
                  <div>
                    <Space>
                      <SlidersHorizontal size={16} />
                      双人早餐
                    </Space>
                    <Switch
                      checked={Boolean(breakfastByBill[bill.id])}
                      onChange={(checked) => {
                        setBreakfastByBill((current) => ({
                          ...current,
                          [bill.id]: checked,
                        }));
                        setPreviewByBill((current) => ({
                          ...current,
                          [bill.id]: undefined,
                        }));
                      }}
                    />
                  </div>
                  {preview ? (
                    <Alert
                      type="info"
                      showIcon
                      message={`调整后 ${money(
                        preview.new_amount,
                        bill.currency,
                      )}`}
                      description={`差额 ${
                        preview.delta_amount >= 0 ? "+" : ""
                      }${money(
                        preview.delta_amount,
                        bill.currency,
                      )}；确认后旧授权会失效。`}
                    />
                  ) : null}
                  <Space wrap>
                    <Button
                      loading={working === `preview:${bill.id}`}
                      onClick={() => void previewAdjustment(bill)}
                    >
                      预览调整
                    </Button>
                    <Button
                      type="primary"
                      disabled={!preview}
                      loading={working === `confirm:${bill.id}`}
                      onClick={() => void confirmAdjustment(bill)}
                    >
                      确认调整
                    </Button>
                  </Space>
                </div>
              ) : null}
            </Card>
          );
        })
      )}

      {pendingBills.length ? (
        <div className={styles.paymentBar}>
          <div>
            <span>已选 {selected.length} 笔</span>
            <strong>{money(selectedAmount)}</strong>
          </div>
          <Button
            type="primary"
            icon={<CreditCard size={17} />}
            disabled={!selected.length}
            loading={working === "pay"}
            onClick={paySelected}
          >
            本人付款
          </Button>
        </div>
      ) : null}
    </section>
  );
}
