import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CirclePlus,
  Pencil,
  RefreshCw,
  ReceiptText,
  Trash2,
  WalletCards,
} from "lucide-react";
import {
  createTripExpense,
  deleteTripExpense,
  listTripExpenses,
  loadTrips,
  updateTripExpense,
  type LocalTrip,
  type TripExpense,
  type TripExpenseCategory,
  type TripExpenseInput,
  type TripExpenseSummary,
} from "./runtime";
import styles from "./mobileLocal.module.less";

const CATEGORY_OPTIONS: Array<{
  value: TripExpenseCategory;
  label: string;
}> = [
  { value: "hotel", label: "住宿" },
  { value: "ticket", label: "门票" },
  { value: "transport", label: "交通" },
  { value: "meal", label: "餐饮" },
  { value: "other", label: "其他" },
];

const CATEGORY_LABEL = Object.fromEntries(
  CATEGORY_OPTIONS.map((item) => [item.value, item.label]),
) as Record<TripExpenseCategory, string>;

const EMPTY_SUMMARY: TripExpenseSummary = {
  total: 0,
  required_total: 0,
  optional_total: 0,
  by_category: {},
  count: 0,
  currency: "CNY",
};

type ExpenseFormValue = {
  title: string;
  category: TripExpenseCategory;
  placeName?: string;
  day?: number;
  amountYuan: number;
  quantity: number;
  required: boolean;
  note?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "操作失败");
}

function money(amount: number, currency = "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
  }).format(amount / 100);
}

function preferredTrip(trips: LocalTrip[]): LocalTrip | undefined {
  return trips.find((trip) => trip.status === "active") || trips[0];
}

export default function HotelBillsPage() {
  const initialTrips = useMemo(() => loadTrips(), []);
  const [form] = Form.useForm<ExpenseFormValue>();
  const [trips, setTrips] = useState<LocalTrip[]>(initialTrips);
  const [selectedTripId, setSelectedTripId] = useState(
    preferredTrip(initialTrips)?.id || "",
  );
  const [expenses, setExpenses] = useState<TripExpense[]>([]);
  const [summary, setSummary] = useState<TripExpenseSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(Boolean(selectedTripId));
  const [working, setWorking] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TripExpense | null>(null);

  const selectedTrip = useMemo(
    () => trips.find((trip) => trip.id === selectedTripId),
    [selectedTripId, trips],
  );

  const refreshExpenses = useCallback(async (tripId: string) => {
    if (!tripId) {
      setExpenses([]);
      setSummary(EMPTY_SUMMARY);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await listTripExpenses(tripId);
      setExpenses(next.expenses);
      setSummary(next.summary);
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshExpenses(selectedTripId);
  }, [refreshExpenses, selectedTripId]);

  const refresh = async () => {
    const nextTrips = loadTrips();
    setTrips(nextTrips);
    const nextTripId = nextTrips.some((trip) => trip.id === selectedTripId)
      ? selectedTripId
      : preferredTrip(nextTrips)?.id || "";
    if (nextTripId !== selectedTripId) {
      setSelectedTripId(nextTripId);
      return;
    }
    await refreshExpenses(nextTripId);
  };

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      title: "",
      category: "other",
      placeName: "",
      day: undefined,
      amountYuan: 0,
      quantity: 1,
      required: true,
      note: "",
    });
    setEditorOpen(true);
  };

  const openEdit = (expense: TripExpense) => {
    setEditing(expense);
    form.setFieldsValue({
      title: expense.title,
      category: expense.category,
      placeName: expense.place_name,
      day: expense.day || undefined,
      amountYuan: expense.unit_amount / 100,
      quantity: expense.quantity,
      required: expense.required,
      note: expense.note,
    });
    setEditorOpen(true);
  };

  const saveExpense = async (values: ExpenseFormValue) => {
    if (!selectedTripId) return;
    const input: TripExpenseInput = {
      title: values.title.trim(),
      category: values.category,
      placeName: values.placeName?.trim(),
      day: values.day || null,
      unitAmount: Math.round(Number(values.amountYuan) * 100),
      quantity: Math.max(1, Math.round(Number(values.quantity))),
      required: values.required,
      note: values.note?.trim(),
    };
    setWorking(editing ? `edit:${editing.id}` : "create");
    try {
      if (editing) {
        await updateTripExpense(editing.id, input);
        message.success("费用已更新");
      } else {
        await createTripExpense(selectedTripId, input);
        message.success("费用已添加");
      }
      setEditorOpen(false);
      setEditing(null);
      await refreshExpenses(selectedTripId);
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setWorking("");
    }
  };

  const removeExpense = async (expense: TripExpense) => {
    setWorking(`delete:${expense.id}`);
    try {
      await deleteTripExpense(expense.id);
      message.success("费用已删除");
      await refreshExpenses(selectedTripId);
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
          <Typography.Title level={3}>账单</Typography.Title>
          <Typography.Text type="secondary">
            按行程查看预算，并管理每一笔旅行花费
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

      <Card className={styles.card}>
        <div className={styles.tripExpenseSelector}>
          <Typography.Text strong>旅行行程选择</Typography.Text>
          <Select
            value={selectedTripId || undefined}
            placeholder="请选择一份旅行行程"
            options={trips.map((trip) => ({
              value: trip.id,
              label: trip.title,
            }))}
            onChange={setSelectedTripId}
            notFoundContent="暂无旅行行程"
            aria-label="旅行行程选择"
          />
        </div>
      </Card>

      {!selectedTrip ? (
        <Card className={styles.card}>
          <Empty description="还没有可选择的行程；请先在“旅程”栏目保存行程" />
        </Card>
      ) : loading && !expenses.length ? (
        <div className={styles.billLoading}>
          <Spin />
        </div>
      ) : (
        <>
          <Card className={styles.expenseSummaryCard}>
            <div className={styles.expenseSummaryTopline}>
              <div>
                <Space size={6}>
                  <WalletCards size={18} />
                  <Typography.Text strong>行程预算总计</Typography.Text>
                </Space>
                <Typography.Text type="secondary">
                  {selectedTrip.title} · 共 {summary.count} 项费用
                </Typography.Text>
              </div>
              <strong>{money(summary.total, summary.currency)}</strong>
            </div>
            <div className={styles.expenseSummaryBreakdown}>
              <div>
                <span>必要支出</span>
                <b>{money(summary.required_total, summary.currency)}</b>
              </div>
              <div>
                <span>可选支出</span>
                <b>{money(summary.optional_total, summary.currency)}</b>
              </div>
            </div>
          </Card>

          <Card
            className={styles.billCard}
            title={
              <Space>
                <ReceiptText size={18} />
                费用明细
              </Space>
            }
            extra={
              <Button
                type="primary"
                size="small"
                icon={<CirclePlus size={15} />}
                onClick={openCreate}
              >
                添加
              </Button>
            }
          >
            {expenses.length ? (
              <div className={styles.expenseList}>
                {expenses.map((expense) => (
                  <div className={styles.expenseItem} key={expense.id}>
                    <div className={styles.expenseItemMain}>
                      <div className={styles.expenseItemHeading}>
                        <div>
                          <strong>{expense.title}</strong>
                          <Space size={4} wrap>
                            <Tag>{CATEGORY_LABEL[expense.category]}</Tag>
                            {expense.day ? (
                              <Tag>第 {expense.day} 天</Tag>
                            ) : null}
                            <Tag
                              color={expense.required ? "orange" : "default"}
                            >
                              {expense.required ? "必要" : "可选"}
                            </Tag>
                          </Space>
                        </div>
                        <strong>
                          {money(expense.amount, expense.currency)}
                        </strong>
                      </div>
                      {expense.place_name || expense.note ? (
                        <Typography.Text
                          type="secondary"
                          className={styles.expenseItemDescription}
                        >
                          {[expense.place_name, expense.note]
                            .filter(Boolean)
                            .join(" · ")}
                        </Typography.Text>
                      ) : null}
                      {expense.quantity > 1 ? (
                        <Typography.Text type="secondary">
                          {money(expense.unit_amount, expense.currency)} ×{" "}
                          {expense.quantity}
                        </Typography.Text>
                      ) : null}
                    </div>
                    <Space size={2} className={styles.expenseItemActions}>
                      <Button
                        type="text"
                        size="small"
                        icon={<Pencil size={15} />}
                        onClick={() => openEdit(expense)}
                        aria-label={`编辑${expense.title}`}
                      />
                      <Popconfirm
                        title="删除这笔费用？"
                        description="删除后，行程预算总计会自动更新。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{
                          danger: true,
                          loading: working === `delete:${expense.id}`,
                        }}
                        onConfirm={() => void removeExpense(expense)}
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<Trash2 size={15} />}
                          aria-label={`删除${expense.title}`}
                        />
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                description="这份行程还没有费用明细"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              >
                <Button icon={<CirclePlus size={15} />} onClick={openCreate}>
                  添加第一笔费用
                </Button>
              </Empty>
            )}
          </Card>
        </>
      )}

      <Modal
        open={editorOpen}
        title={editing ? "编辑费用" : "添加费用"}
        okText={editing ? "保存修改" : "添加费用"}
        cancelText="取消"
        confirmLoading={working === "create" || working.startsWith("edit:")}
        onOk={() => form.submit()}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
      >
        <Form<ExpenseFormValue>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => void saveExpense(values)}
        >
          <Form.Item
            name="title"
            label="费用名称"
            rules={[
              { required: true, whitespace: true, message: "请输入费用名称" },
            ]}
          >
            <Input maxLength={60} placeholder="例如：澳门旅游塔门票" />
          </Form.Item>
          <div className={styles.expenseFormRow}>
            <Form.Item
              name="category"
              label="分类"
              rules={[{ required: true }]}
            >
              <Select options={CATEGORY_OPTIONS} />
            </Form.Item>
            <Form.Item name="day" label="行程天数">
              <InputNumber min={1} precision={0} placeholder="第几天" />
            </Form.Item>
          </div>
          <Form.Item name="placeName" label="地点">
            <Input maxLength={80} placeholder="选填" />
          </Form.Item>
          <div className={styles.expenseFormRow}>
            <Form.Item
              name="amountYuan"
              label="单价（元）"
              rules={[{ required: true, message: "请输入金额" }]}
            >
              <InputNumber min={0} precision={2} prefix="¥" />
            </Form.Item>
            <Form.Item
              name="quantity"
              label="数量"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} precision={0} />
            </Form.Item>
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea
              maxLength={160}
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </Form.Item>
          <Form.Item
            name="required"
            label="计为必要支出"
            valuePropName="checked"
          >
            <Switch checkedChildren="必要" unCheckedChildren="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
