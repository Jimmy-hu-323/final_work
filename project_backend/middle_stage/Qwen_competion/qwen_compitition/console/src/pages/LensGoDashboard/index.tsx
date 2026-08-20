import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from "antd";
import {
  Bot,
  Camera,
  Glasses,
  Image as ImageIcon,
  MapPinned,
  MessageCircle,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  clearLensGoConnection,
  fetchLensGoEvents,
  fetchLensGoMedia,
  fetchLensGoStatus,
  getLensGoBaseUrl,
  getLensGoToken,
  setLensGoBaseUrl,
  setLensGoToken,
  subscribeLensGoEvents,
  type LensGoEvent,
  type LensGoStatus,
} from "../../api/lensgo";
import {
  clearApiBaseUrl,
  getApiBaseUrl,
  setApiBaseUrl,
} from "../../api/config";
import styles from "./index.module.less";

type ConnectionValues = {
  qwenpawBaseUrl: string;
  lensgoBaseUrl: string;
  bridgeToken: string;
};

const EVENT_LABELS: Record<string, string> = {
  text: "眼镜文字",
  image: "图片",
  video: "视频",
  "agent.route": "Agent 路由",
  "agent.collaboration": "Agent 协作",
  "telegram.text": "Telegram 文字",
  "telegram.photo": "Telegram 图片",
};

function eventLabel(event: LensGoEvent): string {
  return EVENT_LABELS[event.event_type] || event.event_type;
}

function eventSummary(event: LensGoEvent): string {
  const value =
    event.data.content ||
    event.data.purpose ||
    event.data.filename ||
    event.data.media_url ||
    event.data.kind;
  return typeof value === "string" ? value : `${event.direction} · ${event.user_id}`;
}

function mergeEvents(current: LensGoEvent[], incoming: LensGoEvent[]): LensGoEvent[] {
  const unique = new Map(current.map((event) => [event.event_id, event]));
  incoming.forEach((event) => unique.set(event.event_id, event));
  return [...unique.values()]
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 120);
}

export default function LensGoDashboard() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<LensGoStatus | null>(null);
  const [events, setEvents] = useState<LensGoEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mediaUrl, setMediaUrl] = useState("");
  const [form] = Form.useForm<ConnectionValues>();

  const refresh = useCallback(async () => {
    if (!getLensGoBaseUrl() || !getLensGoToken()) {
      setError("请先配置 LensGo Bridge 地址与 Token。Token 只保留到本次 App 关闭。 ");
      return;
    }
    setLoading(true);
    try {
      const [nextStatus, nextEvents] = await Promise.all([
        fetchLensGoStatus(),
        fetchLensGoEvents(),
      ]);
      setStatus(nextStatus);
      setEvents((current) => mergeEvents(current, nextEvents));
      setError("");
    } catch (reason) {
      setStatus(null);
      setError(reason instanceof Error ? reason.message : "无法连接 LensGo Bridge");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeLensGoEvents(
      (event) => setEvents((current) => mergeEvents(current, [event])),
      setLive,
    );
    return unsubscribe;
  }, [refresh]);

  const latestMedia = useMemo(
    () =>
      events.find(
        (event) =>
          event.event_type === "image" &&
          typeof event.data.bridge_media_url === "string",
      ),
    [events],
  );

  useEffect(() => {
    let disposed = false;
    let objectUrl = "";
    if (!latestMedia) {
      setMediaUrl("");
      return;
    }
    void fetchLensGoMedia(String(latestMedia.data.bridge_media_url))
      .then((url) => {
        objectUrl = url;
        if (!disposed) setMediaUrl(url);
      })
      .catch(() => {
        if (!disposed) setMediaUrl("");
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [latestMedia]);

  const devices = useMemo(
    () => new Set(events.map((event) => event.device_id).filter(Boolean)).size,
    [events],
  );

  const openSettings = () => {
    form.setFieldsValue({
      qwenpawBaseUrl: getApiBaseUrl(),
      lensgoBaseUrl: getLensGoBaseUrl(),
      bridgeToken: getLensGoToken(),
    });
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    const values = await form.validateFields();
    const qwenChanged = values.qwenpawBaseUrl.trim() !== getApiBaseUrl();
    setApiBaseUrl(values.qwenpawBaseUrl);
    setLensGoBaseUrl(values.lensgoBaseUrl);
    setLensGoToken(values.bridgeToken);
    setSettingsOpen(false);
    message.success("服务器配置已保存");
    if (qwenChanged) {
      window.location.reload();
      return;
    }
    setEvents([]);
    void refresh();
  };

  const resetMobileConnection = () => {
    clearLensGoConnection();
    clearApiBaseUrl();
    window.location.reload();
  };

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <Space align="center" size={10}>
            <span className={styles.heroIcon}><Glasses size={24} /></span>
            <div>
              <Typography.Title level={2} className={styles.title}>LensGo 控制中心</Typography.Title>
              <Typography.Text className={styles.subtitle}>眼镜、Agent、姿势参考图与 Telegram 的统一实时面板</Typography.Text>
            </div>
          </Space>
        </div>
        <Space>
          <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          <Button icon={<Settings2 size={15} />} onClick={openSettings}>连接设置</Button>
        </Space>
      </section>

      {error && <Alert className={styles.alert} type="warning" showIcon message={error} action={<Button size="small" onClick={openSettings}>配置</Button>} />}

      <Row gutter={[12, 12]}>
        <Col xs={12} lg={6}>
          <Card className={styles.metricCard}>
            <Statistic title="LensGo Bridge" value={status ? "在线" : "未连接"} prefix={status ? <Wifi size={18} /> : <WifiOff size={18} />} valueStyle={{ color: status ? "#0f9f6e" : "#a0a0a0", fontSize: 22 }} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className={styles.metricCard}>
            <Statistic title="实时事件流" value={live ? "已连接" : "等待连接"} prefix={<Radio size={18} />} valueStyle={{ color: live ? "#1677ff" : "#a0a0a0", fontSize: 22 }} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className={styles.metricCard}>
            <Statistic title="已发现设备" value={devices} prefix={<Smartphone size={18} />} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className={styles.metricCard}>
            <Statistic title="最近事件" value={events.length} prefix={<Bot size={18} />} />
          </Card>
        </Col>
      </Row>

      <div className={styles.serviceRow}>
        <Tag color={status?.qwenpaw.reachable ? "success" : "default"} icon={<Bot size={13} />}>
          QwenPaw {status?.qwenpaw.reachable ? "可达" : "未确认"}
        </Tag>
        <Tag color={status?.telegram.configured ? "success" : "default"} icon={<Send size={13} />}>
          Telegram {status?.telegram.configured ? "已配置" : "未配置"}
        </Tag>
        <Tag color={live ? "processing" : "default"} icon={<Radio size={13} />}>
          {live ? "实时同步中" : "实时流未连接"}
        </Tag>
      </div>

      <Row gutter={[16, 16]} className={styles.mainGrid}>
        <Col xs={24} xl={10}>
          <Card title={<Space><Camera size={18} />最新画面 / 姿势参考图</Space>} className={styles.panel}>
            {mediaUrl ? (
              <img className={styles.media} src={mediaUrl} alt="LensGo 最新画面" />
            ) : (
              <Empty image={<ImageIcon size={52} strokeWidth={1.3} />} description="眼镜上传或 Agent 生成图片后会显示在这里" />
            )}
          </Card>
          <Card title="快捷入口" className={`${styles.panel} ${styles.quickPanel}`}>
            <div className={styles.quickGrid}>
              <Button icon={<MessageCircle size={18} />} onClick={() => navigate("/chat")}>对话与姿势</Button>
              <Button icon={<MapPinned size={18} />} onClick={() => navigate("/travel-planner")}>旅行规划</Button>
              <Button icon={<ImageIcon size={18} />} onClick={() => navigate("/travel-album")}>旅行相册</Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title={<Space><Radio size={18} />实时事件</Space>} className={`${styles.panel} ${styles.eventsPanel}`}>
            <List
              dataSource={events}
              locale={{ emptyText: "连接眼镜或 Telegram 后，事件会实时显示" }}
              renderItem={(event) => (
                <List.Item className={styles.eventItem}>
                  <div className={styles.eventIcon} data-direction={event.direction}>
                    {event.event_type === "image" ? <ImageIcon size={17} /> : event.direction === "upstream" ? <Glasses size={17} /> : <Bot size={17} />}
                  </div>
                  <div className={styles.eventBody}>
                    <div className={styles.eventTop}>
                      <Typography.Text strong>{eventLabel(event)}</Typography.Text>
                      <Typography.Text type="secondary" className={styles.eventTime}>
                        {new Date(event.timestamp * 1000).toLocaleTimeString()}
                      </Typography.Text>
                    </div>
                    <Typography.Text type="secondary" ellipsis>{eventSummary(event)}</Typography.Text>
                    <div className={styles.eventMeta}>{event.device_id || "未知设备"} · {event.direction}</div>
                  </div>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        title="服务器连接设置"
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        onOk={() => void saveSettings()}
        okText="保存并连接"
        cancelText="取消"
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space wrap>
            {MOBILE && <Button danger onClick={resetMobileConnection}>重新选择全部服务器</Button>}
            <CancelBtn />
            <OkBtn />
          </Space>
        )}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="qwenpawBaseUrl" label="QwenPaw 地址" rules={[{ required: true }]}>
            <Input placeholder="http://192.168.1.20:18088" />
          </Form.Item>
          <Form.Item name="lensgoBaseUrl" label="LensGo Bridge 地址" rules={[{ required: true }]}>
            <Input placeholder="http://192.168.1.20:18000" />
          </Form.Item>
          <Form.Item name="bridgeToken" label="Bridge Token" rules={[{ required: true }]} extra="Token 使用 sessionStorage，只保留到本次 App 关闭。">
            <Input.Password autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
