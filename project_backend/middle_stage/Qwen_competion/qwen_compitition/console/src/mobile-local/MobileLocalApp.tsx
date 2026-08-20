import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import {
  BellRing,
  Bot,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleUserRound,
  Cloud,
  CloudOff,
  CloudUpload,
  Glasses,
  Image as ImageIcon,
  Images,
  KeyRound,
  LocateFixed,
  Map as MapIcon,
  MapPinned,
  MessageCircle,
  Navigation,
  Play,
  RefreshCw,
  ReceiptText,
  Save,
  ScanSearch,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Users,
  Volume2,
  Wifi,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  albumSearchDocument,
  analyzeAlbumImage,
  clearMessages,
  createId,
  deleteAlbumItem,
  deleteCloudAlbumItem,
  extractPhotoMetadata,
  fetchQwenPawLatestItinerary,
  fileToDataUrl,
  generateMobileImage,
  listAlbumItems,
  loadMemory,
  loadMessages,
  loadMobileSettings,
  loadPrivacySettings,
  loadTrips,
  mobileDeviceId,
  mobileChat,
  locationLabel,
  putAlbumItem,
  saveMemory,
  saveMessages,
  saveMobileSettings,
  savePrivacySettings,
  saveTrips,
  searchAlbumItems,
  testMobileProvider,
  testQwenPaw,
  uploadAlbumItemToCloud,
  type AlbumItem,
  type LocalMessage,
  type LocalTrip,
  type MobileSettings,
  type MobileSettingsInput,
  type MobilePrivacySettings,
  type TripPosition,
} from "./runtime";
import {
  announceTripUpdate,
  crowdCatalogForPrompt,
  crowdLabel,
  crowdSnapshot,
  extractTripPlan,
  fetchCrowdPlaces,
  formatCrowdReminder,
  geolocationErrorMessage,
  inferStopsFromMarkdown,
  loadCrowdServiceConfig,
  locateTripStop,
  reorderRemainingStops,
  requestInitialTripPosition,
  revisedTripMarkdown,
  saveCrowdServiceConfig,
  startNativeLocationWatch,
  toTripPosition,
  type CrowdPlace,
  type CrowdServiceConfig,
} from "./tripJourney";
import AlbumMap from "./AlbumMap";
import HotelBillsPage from "./HotelBillsPage";
import TripRouteMap from "./TripRouteMap";
import { loadQwenPawSessionId, streamQwenPawChat } from "./qwenpaw";
import {
  extractAgentTripProposal,
  proposalFromRemoteItinerary,
  remoteItinerarySignature,
} from "./tripSync";
import styles from "./mobileLocal.module.less";

const NAV_ITEMS = [
  { path: "/local/lensgo", label: "LensGo", icon: Glasses },
  { path: "/local/chat", label: "对话", icon: MessageCircle },
  { path: "/local/travel", label: "旅程", icon: MapIcon },
  { path: "/local/bills", label: "账单", icon: ReceiptText },
  { path: "/local/album", label: "相册", icon: Images },
  { path: "/local/settings", label: "设置", icon: Settings2 },
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "操作失败");
}

const PHOTO_SEARCH_PATTERN =
  /照片|图片|相册|拍过|拍的|影像|找图|发给我|发出来|哪一张|哪张/;

function parseJsonObject(value: string): Record<string, unknown> | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function semanticPhotoSearch(
  query: string,
  items: AlbumItem[],
): Promise<{ ids: string[]; reply: string }> {
  const catalog = items.slice(0, 120).map((item) => ({
    id: item.id,
    capturedAt: item.capturedAt
      ? new Date(item.capturedAt).toISOString()
      : undefined,
    location: locationLabel(item.location),
    metadata: albumSearchDocument(item).slice(0, 500),
  }));
  const response = await mobileChat(
    [
      {
        role: "system",
        content:
          '你是私人相册搜索器。只能依据给定目录筛选，不得编造照片。返回 JSON：{"ids":["真实id"],"reply":"简短中文说明"}。理解地点别名、画面内容、时间和自然语言描述；最多返回 12 张。',
      },
      {
        role: "user",
        content: `搜索要求：${query}\n本地照片目录：${JSON.stringify(catalog)}`,
      },
    ],
    { temperature: 0.1, maxTokens: 500 },
  );
  const parsed = parseJsonObject(response.content);
  const validIds = new Set(items.map((item) => item.id));
  const ids = Array.isArray(parsed?.ids)
    ? parsed.ids
        .filter(
          (id): id is string => typeof id === "string" && validIds.has(id),
        )
        .slice(0, 12)
    : [];
  const reply =
    typeof parsed?.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : ids.length
      ? `找到了 ${ids.length} 张相关照片。`
      : "没有找到符合描述的照片。";
  return { ids, reply };
}

function AppHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div>
        <Typography.Title level={3}>{title}</Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
        )}
      </div>
      {action}
    </header>
  );
}

function ProductHeader() {
  return (
    <header className={styles.productHeader}>
      <div className={styles.productBrand}>
        <strong>LensGo</strong>
        <span>澳门旅行助手 · 本地版</span>
      </div>
    </header>
  );
}

function CrowdServiceSettings() {
  const [config, setConfig] = useState<CrowdServiceConfig>({
    baseUrl: "",
    apiKey: "",
    hasApiKey: false,
  });
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true;
    void loadCrowdServiceConfig()
      .then((loaded) => {
        if (active) setConfig(loaded);
      })
      .catch((error) => message.error(errorText(error)))
      .finally(() => {
        if (active) setLoadingConfig(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const saveAndTest = async () => {
    setTesting(true);
    try {
      const next = await saveCrowdServiceConfig(config);
      setConfig(next);
      const result = await fetchCrowdPlaces(next);
      const available = result.items.filter((item) => item.reading).length;
      message.success(
        `客流服务连接成功：${result.count} 个景点，${available} 个有最新人数`,
      );
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setTesting(false);
    }
  };

  const clearApiKey = async () => {
    setTesting(true);
    try {
      const next = await saveCrowdServiceConfig(config, true);
      setConfig(next);
      message.success("本设备的人流 API Key 已清除");
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      className={styles.card}
      title={
        <Space>
          <Users size={18} />
          实时客流服务
        </Space>
      }
    >
      <Alert
        showIcon
        type="info"
        message="连接 data_publish"
        description="请为每台设备分配仅含 crowd:read 权限的人流 API Key。Key 只保存在 App 私有目录，不会写入浏览器 localStorage。模拟器可用 10.0.2.2；真机请填写发布器地址。"
      />
      <div className={styles.crowdSettings}>
        <label>
          <span>客流 API 地址</span>
          <Input
            value={config.baseUrl}
            disabled={loadingConfig}
            placeholder="http://电脑局域网IP:18099"
            inputMode="url"
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                baseUrl: event.target.value,
              }))
            }
          />
        </label>
        <label>
          <span>
            人流 API Key（每设备只读）
            {config.hasApiKey && !config.apiKey ? (
              <Tag color="success">已安全保存</Tag>
            ) : null}
          </span>
          <Input.Password
            value={config.apiKey}
            disabled={loadingConfig}
            autoComplete="new-password"
            placeholder={
              config.hasApiKey ? "留空保留已保存的 Key" : "lgc_live_…"
            }
            onChange={(event) =>
              setConfig((current) => ({
                ...current,
                apiKey: event.target.value,
              }))
            }
          />
        </label>
        <Space wrap>
          <Button
            type="primary"
            icon={<Wifi size={16} />}
            loading={testing}
            disabled={loadingConfig}
            onClick={() => void saveAndTest()}
          >
            保存并测试连接
          </Button>
          <Button
            danger
            icon={<Trash2 size={16} />}
            disabled={loadingConfig || testing || !config.hasApiKey}
            onClick={() => void clearApiKey()}
          >
            清除 API Key
          </Button>
        </Space>
      </div>
    </Card>
  );
}

function PrivacySettingsCard() {
  const [privacy, setPrivacy] =
    useState<MobilePrivacySettings>(loadPrivacySettings);

  const update = (next: MobilePrivacySettings) => {
    setPrivacy(savePrivacySettings(next));
    message.success("隐私与同步设置已保存");
  };

  return (
    <Card
      className={styles.card}
      title={
        <Space>
          <ShieldCheck size={18} />
          Agent 数据权限
        </Space>
      }
    >
      <div className={styles.privacyRows}>
        <div>
          <span>
            <strong>允许主 Agent 使用本地旅程</strong>
            <small>
              仅在发送消息时提供结构化旅程摘要；旅程仍保存在手机本地。
            </small>
          </span>
          <Switch
            checked={privacy.shareTripsWithAgent}
            onChange={(checked) =>
              update({ ...privacy, shareTripsWithAgent: checked })
            }
          />
        </div>
        <label>
          <span>
            <strong>相册云端同步</strong>
            <small>未上传的照片对主 Agent、子 Agent 和 MCP 完全不可见。</small>
          </span>
          <Select
            value={privacy.albumSyncMode}
            options={[
              { value: "off", label: "关闭，仅保存在手机" },
              { value: "selected", label: "只同步手动选择的照片" },
              { value: "automatic", label: "新照片自动同步" },
            ]}
            onChange={(albumSyncMode) => update({ ...privacy, albumSyncMode })}
          />
        </label>
      </div>
      <Alert
        showIcon
        type={privacy.albumSyncMode === "off" ? "success" : "warning"}
        message={
          privacy.albumSyncMode === "off"
            ? "相册当前为仅本地模式"
            : "只有已上传的照片可被 Agent 使用"
        }
        description="关闭同步不会删除手机照片；撤销单张照片的云端授权时，可单独删除云端副本。"
      />
    </Card>
  );
}

function LocalNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <nav className={styles.navigation} aria-label="LensGo 本地主导航">
      {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
        const active = location.pathname.startsWith(path);
        return (
          <button
            type="button"
            key={path}
            className={active ? styles.navigationActive : ""}
            onClick={() => navigate(path)}
          >
            <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function LocalSettingsPage({
  settings,
  onSettings,
}: {
  settings: MobileSettings | null;
  onSettings: (settings: MobileSettings) => void;
}) {
  const [form] = Form.useForm<MobileSettingsInput>();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [qwenpawTesting, setQwenpawTesting] = useState(false);

  useEffect(() => {
    if (!settings) return;
    form.setFieldsValue({
      apiBaseUrl: settings.apiBaseUrl,
      model: settings.model,
      visionModel: settings.visionModel,
      imageBaseUrl: settings.imageBaseUrl,
      imageModel: settings.imageModel,
      systemPrompt: settings.systemPrompt,
      qwenpawBaseUrl: settings.qwenpawBaseUrl,
      qwenpawAgentId: settings.qwenpawAgentId,
    });
  }, [form, settings]);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const next = await saveMobileSettings(values);
      onSettings(next);
      form.setFieldsValue({
        apiKey: "",
        imageApiKey: "",
        qwenpawAuthToken: "",
      });
      message.success("配置已保存到手机本地");
      return true;
    } catch (error) {
      message.error(errorText(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    try {
      if (!(await save())) return;
      setTesting(true);
      const result = await testMobileProvider();
      message.success(result.content || "模型连接成功");
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setTesting(false);
    }
  };

  const testAgent = async () => {
    try {
      if (!(await save())) return;
      setQwenpawTesting(true);
      message.success(await testQwenPaw());
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setQwenpawTesting(false);
    }
  };

  return (
    <section className={styles.page}>
      <AppHeader
        title="LensGo 设置"
        subtitle="本地数据离线可用；智能对话由 QwenPaw 主 Agent 提供"
      />
      <Alert
        showIcon
        type="success"
        message="本地优先 + 联网智能"
        description="旅程和相册始终保存在手机；QwenPaw 只会看到你允许共享的旅程和主动上传到云端的照片。"
      />
      <Form form={form} layout="vertical">
        <Card
          className={styles.card}
          title={
            <Space>
              <Bot size={18} />
              QwenPaw 智能对话
            </Space>
          }
        >
          <Alert
            showIcon
            type="info"
            message="主 Agent、子 Agent、Skills 与 MCP"
            description="手机只展示聊天前端，实际推理和工具调用运行在 QwenPaw。USB 调试时可使用 adb reverse 将手机的 127.0.0.1:18088 映射到电脑。"
          />
          <Form.Item
            name="qwenpawBaseUrl"
            label="QwenPaw 服务地址"
            rules={[
              { required: true, message: "请输入 QwenPaw 地址" },
              { type: "url", message: "请输入完整地址" },
            ]}
            extra="本机 USB 调试默认：http://127.0.0.1:18088；公网部署必须使用 HTTPS。"
          >
            <Input placeholder="http://127.0.0.1:18088" inputMode="url" />
          </Form.Item>
          <Form.Item
            name="qwenpawAgentId"
            label="主 Agent ID"
            rules={[{ required: true, message: "请输入主 Agent ID" }]}
          >
            <Input placeholder="lensgo-travel-director" />
          </Form.Item>
          <Form.Item
            name="qwenpawAuthToken"
            label={
              <Space>
                登录令牌（远程服务可选）
                {settings?.hasQwenpawAuthToken && (
                  <Tag color="success">已保存在应用私有目录</Tag>
                )}
              </Space>
            }
            extra="本机 QwenPaw 未启用 Web 登录时可留空；留空会保留现有令牌。"
          >
            <Input.Password
              autoComplete="off"
              placeholder={
                settings?.hasQwenpawAuthToken
                  ? "留空保留现有令牌"
                  : "Bearer token"
              }
            />
          </Form.Item>
          <Button
            icon={<Wifi size={16} />}
            loading={qwenpawTesting}
            onClick={() => void testAgent()}
          >
            保存并测试 QwenPaw
          </Button>
        </Card>
        <Card
          className={styles.card}
          title={
            <Space>
              <Bot size={18} />
              文字模型
            </Space>
          }
        >
          <Typography.Paragraph type="secondary">
            仅用于离线外的照片识别、姿势图和兼容回退；“对话”页面优先使用上面的
            QwenPaw。
          </Typography.Paragraph>
          <Form.Item
            name="apiBaseUrl"
            label="API Base URL"
            rules={[
              { required: true, message: "请输入 API 地址" },
              { type: "url", message: "请输入完整的 HTTPS 地址" },
            ]}
            extra="填写到 /v1，例如 https://dashscope.aliyuncs.com/compatible-mode/v1"
          >
            <Input placeholder="https://api.example.com/v1" inputMode="url" />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label={
              <Space>
                API Key
                {settings?.hasApiKey && (
                  <Tag color="success">已保存到应用私有目录</Tag>
                )}
              </Space>
            }
            extra="留空会保留已经保存的 Key。Key 不会显示在页面上。"
          >
            <Input.Password
              prefix={<KeyRound size={16} />}
              placeholder={settings?.hasApiKey ? "留空保留现有 Key" : "sk-..."}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item
            name="model"
            label="模型名称"
            rules={[{ required: true, message: "请输入模型名称" }]}
          >
            <Input placeholder="qwen-plus" />
          </Form.Item>
          <Form.Item
            name="visionModel"
            label="识图模型"
            extra="每张导入照片会用它生成地点、内容、文字和搜索标签；留空则使用上面的模型。"
          >
            <Input placeholder="例如：qwen-vl-plus" />
          </Form.Item>
          <Form.Item name="systemPrompt" label="LensGo 助手提示词">
            <Input.TextArea autoSize={{ minRows: 4, maxRows: 8 }} />
          </Form.Item>
          <Space wrap>
            <Button
              type="primary"
              icon={<Save size={16} />}
              loading={saving}
              onClick={() => void save()}
            >
              保存到手机
            </Button>
            <Button
              icon={<Wifi size={16} />}
              loading={testing}
              onClick={() => void test()}
            >
              保存并测试
            </Button>
          </Space>
        </Card>
        <Card
          className={styles.card}
          title={
            <Space>
              <Sparkles size={18} />
              姿势参考图
            </Space>
          }
        >
          <Form.Item
            name="imageBaseUrl"
            label="图片 API Base URL（可选）"
            extra="留空则使用上面的文字 API 地址；当前支持 OpenAI-compatible /images/generations。"
          >
            <Input placeholder="https://api.example.com/v1" inputMode="url" />
          </Form.Item>
          <Form.Item
            name="imageApiKey"
            label={
              <Space>
                图片 API Key（可选）
                {settings?.hasImageApiKey && <Tag color="success">已保存</Tag>}
              </Space>
            }
            extra="留空则使用文字模型的 Key。"
          >
            <Input.Password autoComplete="off" />
          </Form.Item>
          <Form.Item name="imageModel" label="图片模型">
            <Input placeholder="gpt-image-1" />
          </Form.Item>
        </Card>
      </Form>
      <PrivacySettingsCard />
      <CrowdServiceSettings />
      <Card className={styles.securityCard}>
        <Space align="start">
          <ShieldCheck size={22} />
          <div>
            <Typography.Text strong>本地隐私</Typography.Text>
            <p>
              配置文件位于 Android 应用私有沙箱；卸载 App
              会删除本地配置和数据。请不要安装来源不明的调试包或在已 Root
              的手机保存长期密钥。
            </p>
          </div>
        </Space>
      </Card>
    </section>
  );
}

function LocalChatPage({
  settings,
  fallbackConfigured,
}: {
  settings: MobileSettings | null;
  fallbackConfigured: boolean;
}) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<LocalMessage[]>(loadMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [agentActivity, setAgentActivity] = useState("");
  const [albumItems, setAlbumItems] = useState<AlbumItem[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const qwenpawConfigured = Boolean(
    settings?.qwenpawBaseUrl && settings?.qwenpawAgentId,
  );
  const albumById = useMemo(
    () => new Map(albumItems.map((item) => [item.id, item])),
    [albumItems],
  );

  useEffect(() => {
    saveMessages(messages);
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    void listAlbumItems().then(setAlbumItems);
  }, []);

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || sending) return;
    if (!qwenpawConfigured && !fallbackConfigured) {
      message.warning("请先配置 QwenPaw 服务");
      navigate("/local/settings");
      return;
    }
    const userMessage: LocalMessage = {
      id: createId("message"),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    const next = [...messages, userMessage];
    setMessages(next);
    setInput("");
    setSending(true);
    setAgentActivity("正在连接 QwenPaw 主 Agent…");
    try {
      // The legacy direct-model fallback may search the on-device album.
      // QwenPaw mode deliberately skips this branch: local-only photos must
      // remain invisible to the main agent until the user uploads them.
      if (!qwenpawConfigured && PHOTO_SEARCH_PATTERN.test(text)) {
        const currentAlbum = await listAlbumItems();
        setAlbumItems(currentAlbum);
        if (!currentAlbum.length) {
          setMessages((current) => [
            ...current,
            {
              id: createId("message"),
              role: "assistant",
              content: "本地相册还是空的，请先在“相册”页导入照片。",
              createdAt: Date.now(),
            },
          ]);
          return;
        }
        const localMatches = searchAlbumItems(currentAlbum, text).slice(0, 12);
        let result: { ids: string[]; reply: string };
        try {
          result = await semanticPhotoSearch(text, currentAlbum);
        } catch {
          result = {
            ids: localMatches.map((item) => item.id),
            reply: localMatches.length
              ? `按本地标签找到了 ${localMatches.length} 张相关照片。`
              : "暂时没有找到符合描述的照片。识图标注完成后搜索会更准确。",
          };
        }
        if (!result.ids.length && localMatches.length) {
          result.ids = localMatches.map((item) => item.id);
          result.reply = `按地点和画面标签找到了 ${localMatches.length} 张相关照片。`;
        }
        setMessages((current) => [
          ...current,
          {
            id: createId("message"),
            role: "assistant",
            content: result.reply,
            albumItemIds: result.ids,
            createdAt: Date.now(),
          },
        ]);
        return;
      }
      const memory = loadMemory().trim();
      if (qwenpawConfigured) {
        const serverTripBefore = await fetchQwenPawLatestItinerary().catch(
          () => null,
        );
        const privacy = loadPrivacySettings();
        const sharedTrips = privacy.shareTripsWithAgent
          ? loadTrips().map(
              ({
                id,
                title,
                content,
                stops,
                status,
                currentStopIndex,
                startedAt,
                updatedAt,
              }) => ({
                id,
                title,
                content: content.slice(0, 8000),
                stops,
                status,
                currentStopIndex,
                startedAt,
                updatedAt,
              }),
            )
          : [];
        const cloudAlbum = (await listAlbumItems())
          .filter((item) => Number.isFinite(item.cloudFileId))
          .map((item) => ({
            localId: item.id,
            cloudFileId: item.cloudFileId,
            name: item.name,
            capturedAt: item.capturedAt,
            location: locationLabel(item.location),
            analysis: item.analysis,
          }));
        const context = JSON.stringify({
          privacy: {
            tripsShared: privacy.shareTripsWithAgent,
            albumPolicy: privacy.albumSyncMode,
            localOnlyPhotosAreExcluded: true,
          },
          localTravelMemory: memory || undefined,
          trips: sharedTrips,
          cloudAlbum,
          instruction:
            "只能使用本上下文中的旅程和 cloudAlbum；不得声称能看到未同步的本地照片。需要规划或修改路线时使用已配置的澳门旅行 Skill、MCP 和子 Agent。用户确认最终规划后，必须按 Skill 的 LensGo 手机端桥接协议，在回复末尾输出包含完整 stops 和高德坐标的 lensgo-trip-update 代码块。",
        });
        const assistantId = createId("message");
        setMessages((current) => [
          ...current,
          {
            id: assistantId,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
          },
        ]);
        const finalContent = await streamQwenPawChat(
          {
            text,
            sessionId: loadQwenPawSessionId(),
            userId: mobileDeviceId(),
            deviceId: mobileDeviceId(),
            context,
          },
          {
            onText: (content) =>
              setMessages((current) =>
                current.map((item) =>
                  item.id === assistantId ? { ...item, content } : item,
                ),
              ),
            onActivity: (activity) => setAgentActivity(activity.label),
          },
        );
        let proposal = extractAgentTripProposal(finalContent);
        if (!proposal) {
          const serverTripAfter = await fetchQwenPawLatestItinerary().catch(
            () => null,
          );
          if (
            serverTripAfter &&
            remoteItinerarySignature(serverTripAfter) !==
              remoteItinerarySignature(serverTripBefore)
          ) {
            proposal = proposalFromRemoteItinerary(serverTripAfter);
          }
        }
        if (proposal) {
          const currentTrips = loadTrips();
          const target = currentTrips.find(
            (trip) => trip.id === proposal.tripId,
          );
          Modal.confirm({
            title: target
              ? `确认更新“${target.title}”？`
              : "确认保存这份新行程？",
            content: `QwenPaw 建议写入 ${
              proposal.stops?.length || 0
            } 个景点。只有确认后才会修改手机本地旅程；取消则完全保留原行程。`,
            okText: target ? "确认更新" : "保存新行程",
            cancelText: "保留原行程",
            onOk: () => {
              const now = Date.now();
              const latest = loadTrips();
              if (target) {
                saveTrips(
                  latest.map((trip) =>
                    trip.id === proposal.tripId
                      ? {
                          ...trip,
                          title: proposal.title || trip.title,
                          content: proposal.content,
                          stops: proposal.stops,
                          updatedAt: now,
                          syncStatus: "local",
                          cloudUpdatedAt: proposal.sourceUpdatedAt,
                        }
                      : trip,
                  ),
                );
                message.success("QwenPaw 的修改已保存到本地旅程");
              } else {
                const created: LocalTrip = {
                  id:
                    proposal.tripId === "new"
                      ? createId("trip")
                      : proposal.tripId,
                  title: proposal.title || "QwenPaw 澳门行程",
                  request: text,
                  content: proposal.content,
                  stops: proposal.stops,
                  status: "planned",
                  createdAt: now,
                  updatedAt: now,
                  syncStatus: "local",
                  cloudUpdatedAt: proposal.sourceUpdatedAt,
                };
                saveTrips([created, ...latest].slice(0, 30));
                message.success("QwenPaw 行程已保存到本地旅程");
              }
            },
          });
        }
      } else {
        const requestMessages = [
          ...(memory
            ? [
                {
                  role: "system" as const,
                  content: `用户的本地旅行记忆：\n${memory}`,
                },
              ]
            : []),
          ...next.slice(-20).map(({ role, content }) => ({ role, content })),
        ];
        const response = await mobileChat(requestMessages);
        setMessages((current) => [
          ...current,
          {
            id: createId("message"),
            role: "assistant",
            content: response.content,
            createdAt: Date.now(),
          },
        ]);
      }
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setSending(false);
      setAgentActivity("");
    }
  };

  const reset = () => {
    Modal.confirm({
      title: "清空本地对话？",
      content: "只会清除这台手机上的对话，不会删除旅行记忆和相册。",
      okText: "清空",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        clearMessages();
        setMessages([]);
      },
    });
  };

  return (
    <section className={`${styles.page} ${styles.chatPage}`}>
      <AppHeader
        title="LensGo 对话"
        subtitle="QwenPaw 主 Agent · 子 Agent · Skills · MCP"
        action={
          <Button type="text" icon={<Trash2 size={17} />} onClick={reset} />
        }
      />
      {!qwenpawConfigured && (
        <Alert
          showIcon
          type="warning"
          message={
            fallbackConfigured
              ? "QwenPaw 尚未配置，将使用基础模型回退"
              : "尚未配置 QwenPaw"
          }
          action={
            <Button size="small" onClick={() => navigate("/local/settings")}>
              去设置
            </Button>
          }
        />
      )}
      {qwenpawConfigured && !loadPrivacySettings().shareTripsWithAgent && (
        <Alert
          showIcon
          type="info"
          message="主 Agent 当前看不到本地旅程"
          description="如需在对话中查询或调整“旅程”，请在设置里开启“允许主 Agent 使用本地旅程”。"
        />
      )}
      <div className={styles.quickPrompts}>
        {[
          "澳门一日游怎么安排？",
          "大三巴怎么拍照好看？",
          "推荐适合步行的澳门路线",
        ].map((prompt) => (
          <button type="button" key={prompt} onClick={() => void send(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
      <div className={styles.messages}>
        {messages.length === 0 ? (
          <Empty
            image={<MessageCircle size={52} strokeWidth={1.3} />}
            description="问我澳门路线、景点、美食或拍照姿势"
          />
        ) : (
          messages.map((item) => (
            <article
              key={item.id}
              className={
                item.role === "user"
                  ? styles.userMessage
                  : styles.assistantMessage
              }
            >
              <div className={styles.messageAvatar}>
                {item.role === "user" ? (
                  <CircleUserRound size={18} />
                ) : (
                  <Bot size={18} />
                )}
              </div>
              <div className={styles.messageContent}>
                <ReactMarkdown>{item.content}</ReactMarkdown>
                {!!item.albumItemIds?.length && (
                  <div className={styles.chatPhotoResults}>
                    {item.albumItemIds
                      .map((id) => albumById.get(id))
                      .filter((photo): photo is AlbumItem => Boolean(photo))
                      .map((photo) => (
                        <figure key={photo.id}>
                          <img src={photo.dataUrl} alt={photo.name} />
                          <figcaption>
                            {locationLabel(photo.location)}
                          </figcaption>
                        </figure>
                      ))}
                  </div>
                )}
              </div>
            </article>
          ))
        )}
        {sending && (
          <div className={styles.thinking}>
            <Spin size="small" /> {agentActivity || "LensGo 正在思考…"}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className={styles.composer}>
        <Input.TextArea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          autoSize={{ minRows: 1, maxRows: 5 }}
          placeholder="输入旅行问题…"
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="primary"
          shape="circle"
          icon={<Send size={18} />}
          loading={sending}
          disabled={!input.trim()}
          onClick={() => void send()}
        />
      </div>
    </section>
  );
}

function LocalTravelPage({ configured }: { configured: boolean }) {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [trips, setTrips] = useState<LocalTrip[]>(loadTrips);
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<LocalTrip | null>(
    trips.find((trip) => trip.status === "active") || trips[0] || null,
  );
  const [expandedTripId, setExpandedTripId] = useState(
    trips.find((trip) => trip.status === "active")?.id || "",
  );
  const [crowdPlaces, setCrowdPlaces] = useState<CrowdPlace[]>([]);
  const [crowdLoading, setCrowdLoading] = useState(false);
  const [crowdError, setCrowdError] = useState("");
  const [positionText, setPositionText] = useState("等待开启行程");
  const [replanning, setReplanning] = useState(false);
  const selectedRef = useRef<LocalTrip | null>(selected);
  const crowdPlacesRef = useRef<CrowdPlace[]>(crowdPlaces);
  const lastCrowdFetchRef = useRef(0);
  const notifiedRef = useRef("");

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    crowdPlacesRef.current = crowdPlaces;
  }, [crowdPlaces]);

  const refreshCrowd = async (silent = false): Promise<CrowdPlace[]> => {
    if (!silent) setCrowdLoading(true);
    try {
      const result = await fetchCrowdPlaces();
      setCrowdPlaces(result.items);
      crowdPlacesRef.current = result.items;
      lastCrowdFetchRef.current = Date.now();
      setCrowdError("");
      return result.items;
    } catch (error) {
      setCrowdError(errorText(error));
      if (!silent) message.error(errorText(error));
      return crowdPlacesRef.current;
    } finally {
      if (!silent) setCrowdLoading(false);
    }
  };

  useEffect(() => {
    void refreshCrowd(true);
  }, []);

  const replaceTrip = (
    tripId: string,
    updater: (trip: LocalTrip) => LocalTrip,
  ) => {
    setTrips((current) => {
      const next = current.map((trip) =>
        trip.id === tripId ? updater(trip) : trip,
      );
      saveTrips(next);
      const updated = next.find((trip) => trip.id === tripId) || null;
      setSelected(updated);
      selectedRef.current = updated;
      return next;
    });
  };

  const generate = async () => {
    if (!configured) {
      message.warning("请先配置模型 API");
      navigate("/local/settings");
      return;
    }
    const values = await form.validateFields();
    const request = `${values.days} 天澳门旅行；出发区域：${
      values.start || "澳门"
    }；兴趣：${values.interests}; 节奏：${values.pace}；补充：${
      values.notes || "无"
    }`;
    setGenerating(true);
    try {
      const places = crowdPlaces.length
        ? crowdPlaces
        : await refreshCrowd(true);
      const result = await mobileChat(
        [
          {
            role: "system",
            content:
              '你是澳门本地旅行规划师。只返回一个 JSON 对象，不要代码围栏：{"markdown":"完整 Markdown 行程","stops":[{"id":"stop-1","name":"景点名","day":1,"time":"09:00","note":"交通或提醒","crowdRegionId":"客流目录中的 id"}]}。每天按时间排序；day 必须是从 1 开始的行程天数；说明景点间交通、预计时间、预约提示、雨天替代与安全提醒。crowdRegionId 只能从给定客流目录选择，餐厅和无法匹配的地点不要放进 stops；不要虚构实时人数、票价或营业状态。',
          },
          {
            role: "user",
            content: `${request}\n可跟踪的澳门客流景点目录：${crowdCatalogForPrompt(
              places,
            )}`,
          },
        ],
        { temperature: 0.4, maxTokens: 3000 },
      );
      const plan = extractTripPlan(result.content, places);
      const trip: LocalTrip = {
        id: createId("trip"),
        title: `${values.days} 天澳门行程`,
        request,
        content: plan.content,
        stops: plan.stops,
        status: "planned",
        createdAt: Date.now(),
      };
      const next = [trip, ...trips].slice(0, 30);
      setTrips(next);
      saveTrips(next);
      setSelected(trip);
      setExpandedTripId(trip.id);
      message.success("行程已保存到手机");
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setGenerating(false);
    }
  };

  const replanTrip = async (tripId: string) => {
    setReplanning(true);
    try {
      const places = await refreshCrowd(true);
      const trip = selectedRef.current;
      if (!trip || trip.id !== tripId) return;
      const hasFreshCrowd = (trip.stops || []).some((stop) => {
        const snapshot = crowdSnapshot(stop, places);
        return Boolean(snapshot?.reading && !snapshot.stale);
      });
      if (!hasFreshCrowd) {
        message.warning("当前没有可用的实时客流数据，已保留原行程顺序");
        return;
      }
      const reordered = reorderRemainingStops(trip, places);
      const currentIndex = trip.currentStopIndex ?? -1;
      replaceTrip(tripId, (current) => ({
        ...current,
        stops: reordered,
        content: revisedTripMarkdown(current.content, reordered, currentIndex),
        updatedAt: Date.now(),
      }));
      announceTripUpdate(
        "行程已更新",
        `已根据当前客流更新后续顺序，下一站是${
          reordered[currentIndex + 1]?.name || "行程终点"
        }。`,
      );
      message.success("已按最新客流更新今天的后续行程");
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setReplanning(false);
    }
  };

  const showNextStopReminder = (
    trip: LocalTrip,
    currentIndex: number,
    places: CrowdPlace[],
  ) => {
    const nextStop = trip.stops?.[currentIndex + 1];
    if (!nextStop) return;
    const snapshot = crowdSnapshot(nextStop, places);
    const signature = `${trip.id}:${nextStop.id}:${
      snapshot?.reading?.batch_id || "none"
    }`;
    if (notifiedRef.current === signature) return;
    notifiedRef.current = signature;
    const reminder = formatCrowdReminder(nextStop, snapshot);
    announceTripUpdate("LensGo 下一站提醒", reminder);
    Modal.confirm({
      title: `下一站：${nextStop.name}`,
      icon: <BellRing size={22} color="#ff7f16" />,
      content: (
        <div className={styles.reminderContent}>
          {snapshot?.reading ? (
            <>
              <strong>{snapshot.reading.people_count} 人</strong>
              <Tag
                color={
                  snapshot.stale
                    ? "default"
                    : snapshot.reading.crowd_level >= 3
                    ? "error"
                    : "success"
                }
              >
                {snapshot.stale
                  ? "数据已过期"
                  : crowdLabel(snapshot.reading.crowd_level)}
              </Tag>
            </>
          ) : (
            <Tag>暂无人数数据</Tag>
          )}
          <p>{reminder}</p>
        </div>
      ),
      okText: "按客流调整",
      cancelText: "不用，继续",
      onOk: () => replanTrip(trip.id),
    });
  };

  const handlePosition = async (tripId: string, position: TripPosition) => {
    const trip = selectedRef.current;
    if (!trip || trip.id !== tripId || trip.status !== "active") return;
    const located = locateTripStop(trip, position);
    const previousIndex = trip.currentStopIndex ?? -1;
    const currentIndex = located
      ? Math.max(previousIndex, located.index)
      : previousIndex;
    setPositionText(
      located
        ? `已到达 ${
            trip.stops?.[located.index]?.name || "行程地点"
          } · 误差约 ${Math.round(position.accuracy)} 米`
        : `定位正常 · 误差约 ${Math.round(position.accuracy)} 米`,
    );
    replaceTrip(tripId, (current) => ({
      ...current,
      currentStopIndex: currentIndex,
      lastPosition: position,
    }));
    let places = crowdPlacesRef.current;
    if (!places.length || Date.now() - lastCrowdFetchRef.current > 2 * 60_000) {
      places = await refreshCrowd(true);
    }
    const latestTrip = selectedRef.current;
    if (latestTrip?.id === tripId) {
      showNextStopReminder(latestTrip, currentIndex, places);
    }
  };

  useEffect(() => {
    const trip = selected;
    if (trip?.status !== "active") return;
    setPositionText("正在获取手机位置…");
    const nativeCleanup = startNativeLocationWatch(
      (position) => void handlePosition(trip.id, position),
      (error) => {
        setPositionText(error);
        message.error(error);
      },
    );
    if (nativeCleanup) return nativeCleanup;
    if (!("geolocation" in navigator)) {
      setPositionText("此设备不支持定位");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => void handlePosition(trip.id, toTripPosition(position)),
      (error) => {
        const text = geolocationErrorMessage(error);
        setPositionText(text);
        message.error(text);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15_000,
        timeout: 20_000,
      },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [selected?.id, selected?.status]);

  const startTrip = () => {
    if (!selected) return;
    const places = crowdPlacesRef.current;
    const stops = selected.stops?.length
      ? selected.stops
      : inferStopsFromMarkdown(selected.content, places);
    if (!stops.length) {
      message.warning("这份行程没有可定位的景点，请重新生成一份可跟踪行程");
      return;
    }
    if (
      !window.LensGoNative?.startLocationUpdates &&
      !("geolocation" in navigator)
    ) {
      message.error("此设备不支持定位功能");
      return;
    }
    Modal.confirm({
      title: "确认开始这份行程？",
      icon: <LocateFixed size={22} color="#ff7f16" />,
      content:
        "开启后 LensGo 才会读取手机位置，用于判断已到达的景点、查询下一站人数并发送提醒。未开启的规划不会跟踪位置。",
      okText: "允许定位并开始",
      cancelText: "暂不开始",
      onOk: async () => {
        try {
          const position = window.LensGoNative?.startLocationUpdates
            ? await requestInitialTripPosition()
            : await new Promise<TripPosition>((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(
                  (rawPosition) => resolve(toTripPosition(rawPosition)),
                  (error) => reject(new Error(geolocationErrorMessage(error))),
                  {
                    enableHighAccuracy: true,
                    maximumAge: 5_000,
                    timeout: 20_000,
                  },
                );
              });
          const prepared: LocalTrip = {
            ...selected,
            stops,
            currentStopIndex: -1,
          };
          const located = locateTripStop(prepared, position);
          const currentIndex = located?.index ?? -1;
          setTrips((current) => {
            const next = current.map((trip) => {
              if (trip.id === selected.id) {
                return {
                  ...trip,
                  stops,
                  status: "active" as const,
                  currentStopIndex: currentIndex,
                  startedAt: Date.now(),
                  completedAt: undefined,
                  lastPosition: position,
                };
              }
              return trip.status === "active"
                ? { ...trip, status: "planned" as const }
                : trip;
            });
            saveTrips(next);
            const active = next.find((trip) => trip.id === selected.id) || null;
            setSelected(active);
            setExpandedTripId(selected.id);
            selectedRef.current = active;
            return next;
          });
          notifiedRef.current = "";
          announceTripUpdate(
            "行程已开始",
            `${selected.title}已开始，LensGo 会根据位置提醒下一站客流。`,
          );
          message.success("行程已开始，位置跟踪已开启");
        } catch (error) {
          message.error(errorText(error));
          throw error;
        }
      },
    });
  };

  const finishTrip = () => {
    if (!selected) return;
    Modal.confirm({
      title: "结束当前行程？",
      content: "结束后会停止位置跟踪；行程与调整记录仍保存在手机中。",
      okText: "结束行程",
      cancelText: "继续行程",
      onOk: () => {
        replaceTrip(selected.id, (trip) => ({
          ...trip,
          status: "completed",
          completedAt: Date.now(),
        }));
        setPositionText("行程已结束");
        announceTripUpdate("行程已结束", "今天的行程已结束，位置跟踪已停止。");
      },
    });
  };

  const selectedIndex = selected?.currentStopIndex ?? -1;
  const nextStop = selected?.stops?.[selectedIndex + 1];
  const nextCrowd = nextStop ? crowdSnapshot(nextStop, crowdPlaces) : undefined;

  return (
    <section className={styles.page}>
      <AppHeader
        title="本地旅行规划"
        subtitle="只有确认开始的行程才会读取位置并发送客流提醒"
        action={
          <Button
            type="text"
            icon={<RefreshCw size={17} />}
            loading={crowdLoading}
            onClick={() => void refreshCrowd()}
          />
        }
      />
      {crowdError && (
        <Alert
          showIcon
          type="warning"
          message="客流服务暂不可用"
          description={`${crowdError}。定位和行程仍可使用，但不会显示实时人数。`}
          action={
            <Button size="small" onClick={() => navigate("/local/settings")}>
              检查设置
            </Button>
          }
        />
      )}
      <Card className={styles.card}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            days: 1,
            pace: "适中",
            interests: "历史建筑、美食、拍照",
          }}
        >
          <div className={styles.formGrid}>
            <Form.Item name="days" label="天数" rules={[{ required: true }]}>
              <InputNumber min={1} max={14} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="pace" label="节奏">
              <Select
                options={["轻松", "适中", "紧凑"].map((value) => ({
                  value,
                  label: value,
                }))}
              />
            </Form.Item>
          </div>
          <Form.Item name="start" label="出发区域">
            <Input placeholder="例如：澳门半岛、氹仔酒店" />
          </Form.Item>
          <Form.Item
            name="interests"
            label="旅行兴趣"
            rules={[{ required: true }]}
          >
            <Input placeholder="历史、美食、亲子、拍照…" />
          </Form.Item>
          <Form.Item name="notes" label="补充要求">
            <Input.TextArea placeholder="同行人数、行动不便、预算、饮食偏好…" />
          </Form.Item>
          <Button
            type="primary"
            block
            icon={<Sparkles size={17} />}
            loading={generating}
            onClick={() => void generate()}
          >
            生成并保存行程
          </Button>
        </Form>
      </Card>
      {trips.length > 0 && (
        <div className={styles.tripTabs}>
          {trips.map((trip) => (
            <button
              type="button"
              key={trip.id}
              className={selected?.id === trip.id ? styles.tripTabActive : ""}
              onClick={() => {
                setSelected(trip);
                selectedRef.current = trip;
                setExpandedTripId((current) =>
                  current === trip.id ? "" : trip.id,
                );
              }}
            >
              <span className={styles.tripSummaryIcon}>
                <MapPinned size={17} />
              </span>
              <span className={styles.tripSummaryText}>
                <strong>{trip.title}</strong>
                <small>
                  {trip.status === "active"
                    ? "进行中"
                    : trip.status === "completed"
                    ? "已完成"
                    : "未开始"}
                  {" · "}
                  {trip.stops?.length || 0} 个景点
                  {" · "}
                  {new Date(
                    trip.updatedAt || trip.createdAt,
                  ).toLocaleDateString()}
                </small>
              </span>
              <Tag
                color={
                  trip.status === "active"
                    ? "processing"
                    : trip.status === "completed"
                    ? "success"
                    : "default"
                }
              >
                {trip.status === "active"
                  ? "进行中"
                  : trip.status === "completed"
                  ? "已结束"
                  : "已规划"}
              </Tag>
              {expandedTripId === trip.id ? (
                <ChevronUp size={17} />
              ) : (
                <ChevronDown size={17} />
              )}
            </button>
          ))}
        </div>
      )}
      {selected && expandedTripId === selected.id ? (
        <>
          <Card
            className={`${styles.card} ${
              selected.status === "active" ? styles.activeTripCard : ""
            }`}
          >
            <div className={styles.tripActivation}>
              <div>
                <Tag
                  color={
                    selected.status === "active"
                      ? "processing"
                      : selected.status === "completed"
                      ? "success"
                      : "default"
                  }
                >
                  {selected.status === "active"
                    ? "行程进行中"
                    : selected.status === "completed"
                    ? "行程已结束"
                    : "仅规划，尚未开始"}
                </Tag>
                <Typography.Title level={4}>{selected.title}</Typography.Title>
                <Typography.Text type="secondary">
                  {selected.status === "active"
                    ? positionText
                    : "不会读取位置，也不会发送提醒"}
                </Typography.Text>
              </div>
              {selected.status === "active" ? (
                <Button danger icon={<Square size={15} />} onClick={finishTrip}>
                  结束
                </Button>
              ) : (
                <Button
                  type="primary"
                  icon={<Play size={16} />}
                  onClick={startTrip}
                >
                  确认开始行程
                </Button>
              )}
            </div>
            {selected.status === "active" && nextStop && (
              <div className={styles.nextStopPanel}>
                <div>
                  <Navigation size={20} />
                  <span>
                    <small>下一站</small>
                    <strong>{nextStop.name}</strong>
                  </span>
                </div>
                <div>
                  <Users size={20} />
                  <span>
                    <small>最新客流</small>
                    <strong>
                      {nextCrowd?.reading
                        ? `${nextCrowd.reading.people_count} 人`
                        : "暂无数据"}
                    </strong>
                  </span>
                </div>
                <div>
                  <Volume2 size={20} />
                  <span>
                    <small>提醒方式</small>
                    <strong>手机弹窗 + 眼镜语音</strong>
                  </span>
                </div>
              </div>
            )}
            {!!selected.stops?.length && (
              <>
                <div className={styles.tripMapTitle}>
                  <MapIcon size={17} />
                  <strong>路线图</strong>
                  <span>路线与坐标保存在手机，可离线查看顺序</span>
                </div>
                <TripRouteMap
                  trip={selected}
                  currentStopIndex={selectedIndex}
                />
                <div className={styles.tripRoute}>
                  {selected.stops.map((stop, index) => {
                    const snapshot = crowdSnapshot(stop, crowdPlaces);
                    return (
                      <div
                        key={stop.id}
                        className={
                          index <= selectedIndex
                            ? styles.tripStopDone
                            : index === selectedIndex + 1
                            ? styles.tripStopNext
                            : ""
                        }
                      >
                        <span className={styles.tripStopIndex}>
                          {index <= selectedIndex ? (
                            <CheckCircle2 size={16} />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <span>
                          <strong>{stop.name}</strong>
                          <small>
                            {[
                              stop.day ? `第 ${stop.day} 天` : "",
                              stop.time || stop.note || "按行程前往",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </span>
                        {snapshot?.reading && (
                          <Tag
                            color={
                              snapshot.stale
                                ? "default"
                                : snapshot.reading.crowd_level >= 3
                                ? "error"
                                : "success"
                            }
                          >
                            {snapshot.stale
                              ? "已过期"
                              : `${snapshot.reading.people_count} 人`}
                          </Tag>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {selected.status === "active" && (
              <Button
                block
                icon={<Users size={16} />}
                loading={replanning}
                onClick={() => void replanTrip(selected.id)}
              >
                现在按实时人流更新后续行程
              </Button>
            )}
          </Card>
          <Card className={`${styles.card} ${styles.markdownCard}`}>
            <ReactMarkdown>{selected.content}</ReactMarkdown>
          </Card>
        </>
      ) : (
        <Empty
          description={
            trips.length
              ? "点击上方任意行程展开详情"
              : "生成第一份澳门行程后会显示在这里"
          }
        />
      )}
    </section>
  );
}

function useAlbum() {
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    try {
      setItems(await listAlbumItems());
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return { items, loading, refresh };
}

function mergeAlbumAnalysis(
  item: AlbumItem,
  analysis: Awaited<ReturnType<typeof analyzeAlbumImage>>,
): AlbumItem {
  const aiCoordinatesAreReliable =
    (analysis.locationConfidence || 0) >= 0.75 &&
    Number.isFinite(analysis.latitude) &&
    Number.isFinite(analysis.longitude);
  const existing = item.location;
  const locationCandidate = {
    source: existing?.source || ("ai" as const),
    confidence: existing?.source === "exif" ? 1 : analysis.locationConfidence,
    latitude:
      existing?.latitude ??
      (aiCoordinatesAreReliable ? analysis.latitude : undefined),
    longitude:
      existing?.longitude ??
      (aiCoordinatesAreReliable ? analysis.longitude : undefined),
    landmark: existing?.landmark || analysis.landmark,
    address: existing?.address || analysis.address,
    district: existing?.district || analysis.district,
    city: existing?.city || analysis.city,
    region: existing?.region || analysis.region,
    country: existing?.country || analysis.country,
  };
  const hasLocation = Object.entries(locationCandidate).some(
    ([key, value]) => key !== "source" && value !== undefined && value !== "",
  );
  return {
    ...item,
    location: hasLocation ? locationCandidate : undefined,
    analysis: {
      description: analysis.description,
      scene: analysis.scene,
      tags: analysis.tags,
      objects: analysis.objects,
      visibleText: analysis.visibleText,
      peopleSummary: analysis.peopleSummary,
      activity: analysis.activity,
      timeOfDay: analysis.timeOfDay,
      searchText: analysis.searchText,
    },
    analysisStatus: "ready",
    analysisError: undefined,
    analyzedAt: Date.now(),
  };
}

function LocalAlbumPage({ configured }: { configured: boolean }) {
  const { items, loading, refresh } = useAlbum();
  const inputRef = useRef<HTMLInputElement>(null);
  const [privacy] = useState<MobilePrivacySettings>(loadPrivacySettings);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "map">("grid");
  const [processing, setProcessing] = useState("");
  const [detailItem, setDetailItem] = useState<AlbumItem | null>(null);
  const [mapSelection, setMapSelection] = useState<{
    ids: Set<string>;
    label: string;
  } | null>(null);

  const filteredItems = useMemo(
    () => searchAlbumItems(items, query),
    [items, query],
  );
  const visibleItems = useMemo(() => {
    if (!mapSelection) return filteredItems;
    return filteredItems.filter((item) => mapSelection.ids.has(item.id));
  }, [filteredItems, mapSelection]);
  const placeGroups = useMemo(() => {
    const groups = new Map<string, number>();
    for (const item of items) {
      const label = locationLabel(item.location);
      if (label !== "未识别地点") {
        groups.set(label, (groups.get(label) || 0) + 1);
      }
    }
    return [...groups.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12);
  }, [items]);

  const analyzeAndStore = async (item: AlbumItem): Promise<AlbumItem> => {
    const analyzing: AlbumItem = {
      ...item,
      analysisStatus: "analyzing",
      analysisError: undefined,
    };
    await putAlbumItem(analyzing);
    await refresh();
    try {
      const analysis = await analyzeAlbumImage(analyzing);
      const completed = mergeAlbumAnalysis(analyzing, analysis);
      await putAlbumItem(completed);
      return completed;
    } catch (error) {
      const failed: AlbumItem = {
        ...analyzing,
        analysisStatus: "failed",
        analysisError: errorText(error),
      };
      await putAlbumItem(failed);
      return failed;
    } finally {
      await refresh();
    }
  };

  const syncItemToCloud = async (
    item: AlbumItem,
    notify = true,
  ): Promise<AlbumItem> => {
    const uploading: AlbumItem = { ...item, syncStatus: "uploading" };
    await putAlbumItem(uploading);
    await refresh();
    try {
      const result = await uploadAlbumItemToCloud(uploading);
      const synced: AlbumItem = {
        ...uploading,
        cloudFileId: result.fileId,
        cloudSyncedAt: Date.now(),
        syncStatus: "synced",
      };
      await putAlbumItem(synced);
      setDetailItem((current) =>
        current?.id === synced.id ? synced : current,
      );
      await refresh();
      if (notify)
        message.success("已上传云端，并授权 QwenPaw Agent 查看这张照片");
      return synced;
    } catch (error) {
      const failed: AlbumItem = { ...item, syncStatus: "failed" };
      await putAlbumItem(failed);
      setDetailItem((current) =>
        current?.id === failed.id ? failed : current,
      );
      await refresh();
      if (notify) message.error(errorText(error));
      throw error;
    }
  };

  const revokeCloudCopy = async (item: AlbumItem) => {
    if (!item.cloudFileId) return;
    setProcessing(`正在撤销云端访问：${item.name}`);
    try {
      await deleteCloudAlbumItem(item.cloudFileId);
      const localOnly: AlbumItem = {
        ...item,
        cloudFileId: undefined,
        cloudSyncedAt: undefined,
        syncStatus: "local",
      };
      await putAlbumItem(localOnly);
      setDetailItem(localOnly);
      await refresh();
      message.success("云端副本已删除，照片仍保留在手机本地，Agent 无法再查看");
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setProcessing("");
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const selectedFiles = Array.from(files);
      let failed = 0;
      for (const [index, file] of selectedFiles.entries()) {
        setProcessing(
          `正在导入并整理 ${index + 1}/${selectedFiles.length}：${file.name}`,
        );
        const metadata = await extractPhotoMetadata(file);
        let item: AlbumItem = {
          id: createId("image"),
          name: file.name,
          dataUrl: await fileToDataUrl(file),
          source: "upload",
          createdAt: Date.now(),
          capturedAt: metadata.capturedAt,
          location: metadata.location,
          analysisStatus: configured ? "analyzing" : "pending",
          syncStatus: "local",
        };
        await putAlbumItem(item);
        await refresh();
        if (configured) {
          const result = await analyzeAndStore(item);
          item = result;
          if (result.analysisStatus === "failed") failed += 1;
        }
        if (privacy.albumSyncMode === "automatic") {
          setProcessing(
            `正在自动同步 ${index + 1}/${selectedFiles.length}：${file.name}`,
          );
          try {
            await syncItemToCloud(item, false);
          } catch {
            failed += 1;
          }
        }
      }
      await refresh();
      if (!configured) {
        message.warning("照片已保存；配置识图模型后可补充 AI 标注");
      } else if (failed) {
        message.warning(`照片已保存，${failed} 张识图失败，可稍后重试`);
      } else {
        message.success("照片已保存，并完成地点与内容标注");
      }
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setProcessing("");
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const analyzePending = async () => {
    if (!configured) {
      message.warning("请先在设置中配置 API Key 和识图模型");
      return;
    }
    const pending = items.filter((item) => item.analysisStatus !== "ready");
    if (!pending.length) {
      message.info("所有照片都已完成标注");
      return;
    }
    setProcessing(`准备整理 ${pending.length} 张照片`);
    for (const [index, item] of pending.entries()) {
      setProcessing(`AI 正在整理 ${index + 1}/${pending.length}：${item.name}`);
      await analyzeAndStore(item);
    }
    setProcessing("");
    message.success("相册标注已更新");
  };

  const remove = async (item: AlbumItem) => {
    Modal.confirm({
      title: `删除“${item.name}”？`,
      content: item.cloudFileId
        ? "这里只删除手机本地副本。云端副本仍会保留；如需撤销 Agent 访问，请先在照片详情中删除云端副本。"
        : "照片只保存在手机本地，删除后无法恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        await deleteAlbumItem(item.id);
        setDetailItem(null);
        await refresh();
      },
    });
  };

  return (
    <section className={styles.page}>
      <AppHeader
        title="本地旅行相册"
        subtitle="离线可看；默认只保存在手机，只有你主动同步的照片 Agent 才能看到"
        action={
          <>
            <input
              ref={inputRef}
              hidden
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => void upload(event.target.files)}
            />
            <Button
              icon={<Upload size={17} />}
              onClick={() => inputRef.current?.click()}
            >
              导入
            </Button>
          </>
        }
      />
      <Alert
        className={styles.cloudPrivacyBanner}
        showIcon
        type={privacy.albumSyncMode === "off" ? "success" : "info"}
        icon={
          privacy.albumSyncMode === "off" ? (
            <ShieldCheck size={18} />
          ) : (
            <Cloud size={18} />
          )
        }
        message={
          privacy.albumSyncMode === "off"
            ? "隐私模式：全部照片仅保存在手机本地"
            : privacy.albumSyncMode === "selected"
            ? "选择同步：只有点按云端按钮的照片会授权给 Agent"
            : "自动同步：新导入的照片会上传云端并授权给 Agent"
        }
      />
      <Input
        allowClear
        value={query}
        prefix={<Search size={17} />}
        placeholder="搜索地点或画面，例如：新葡京、夜景、红色衣服"
        onChange={(event) => {
          setQuery(event.target.value);
          setMapSelection(null);
        }}
      />
      <div className={styles.albumToolbar}>
        <Segmented
          value={view}
          options={[
            { label: "照片", value: "grid" },
            { label: "地图", value: "map" },
          ]}
          onChange={(value) => {
            setView(value as "grid" | "map");
            setMapSelection(null);
          }}
        />
        <Button
          size="small"
          icon={<ScanSearch size={15} />}
          loading={Boolean(processing)}
          onClick={() => void analyzePending()}
        >
          整理未标注
        </Button>
      </div>
      {!!placeGroups.length && (
        <div className={styles.placeChips}>
          <button
            type="button"
            className={!query ? styles.placeChipActive : ""}
            onClick={() => {
              setQuery("");
              setMapSelection(null);
            }}
          >
            全部 · {items.length}
          </button>
          {placeGroups.map(([label, count]) => (
            <button
              type="button"
              key={label}
              className={query === label ? styles.placeChipActive : ""}
              onClick={() => {
                setQuery(label);
                setMapSelection(null);
              }}
            >
              {label} · {count}
            </button>
          ))}
        </div>
      )}
      {processing && (
        <div className={styles.albumProcessing}>
          <Spin size="small" />
          <span>{processing}</span>
        </div>
      )}
      {loading ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty
          image={<Images size={52} />}
          description="导入旅行照片或在 LensGo 页生成姿势参考图"
        />
      ) : (
        <>
          {view === "map" && (
            <>
              <AlbumMap
                items={filteredItems}
                onSelect={(selected, label) =>
                  setMapSelection({
                    ids: new Set(selected.map((item) => item.id)),
                    label,
                  })
                }
              />
              <p className={styles.mapPrivacy}>
                地图服务只接收当前地图瓦片范围，不会收到照片或 AI 标注。
              </p>
            </>
          )}
          {mapSelection && (
            <div className={styles.mapSelection}>
              <MapPinned size={16} />
              <span>
                {mapSelection.label} · {mapSelection.ids.size} 张
              </span>
              <Button
                type="text"
                size="small"
                onClick={() => setMapSelection(null)}
              >
                查看全部
              </Button>
            </div>
          )}
          {visibleItems.length === 0 ? (
            <Empty description="没有找到符合条件的照片" />
          ) : (
            <div className={styles.gallery}>
              {visibleItems.map((item) => (
                <article key={item.id} className={styles.galleryItem}>
                  <button
                    type="button"
                    className={styles.galleryPreview}
                    onClick={() => setDetailItem(item)}
                  >
                    <img src={item.dataUrl} alt={item.name} />
                    {item.analysisStatus && item.analysisStatus !== "ready" && (
                      <span className={styles.analysisBadge}>
                        {item.analysisStatus === "analyzing"
                          ? "AI 整理中"
                          : item.analysisStatus === "failed"
                          ? "标注失败"
                          : "待标注"}
                      </span>
                    )}
                  </button>
                  <div className={styles.galleryMeta}>
                    <span>
                      <strong>{locationLabel(item.location)}</strong>
                      <small>{item.analysis?.scene || item.name}</small>
                    </span>
                    <span className={styles.galleryActions}>
                      <button
                        type="button"
                        className={item.cloudFileId ? styles.cloudSynced : ""}
                        aria-label={
                          item.cloudFileId ? "已同步云端" : "同步至云端"
                        }
                        disabled={item.syncStatus === "uploading"}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (item.cloudFileId) {
                            setDetailItem(item);
                          } else {
                            void syncItemToCloud(item);
                          }
                        }}
                      >
                        {item.cloudFileId ? (
                          <Cloud size={16} />
                        ) : (
                          <CloudUpload size={16} />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="删除图片"
                        onClick={() => void remove(item)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      <Modal
        open={Boolean(detailItem)}
        title={detailItem?.name}
        footer={
          detailItem
            ? [
                <Button
                  key="analyze"
                  icon={<RefreshCw size={15} />}
                  disabled={!configured || Boolean(processing)}
                  onClick={async () => {
                    setProcessing(`AI 正在重新整理：${detailItem.name}`);
                    const updated = await analyzeAndStore(detailItem);
                    setDetailItem(updated);
                    setProcessing("");
                  }}
                >
                  重新识别
                </Button>,
                detailItem.cloudFileId ? (
                  <Button
                    key="cloud"
                    danger
                    icon={<CloudOff size={15} />}
                    disabled={Boolean(processing)}
                    onClick={() => void revokeCloudCopy(detailItem)}
                  >
                    删除云端副本
                  </Button>
                ) : (
                  <Button
                    key="cloud"
                    icon={<CloudUpload size={15} />}
                    disabled={Boolean(processing)}
                    onClick={() => void syncItemToCloud(detailItem)}
                  >
                    上传云端并授权 Agent
                  </Button>
                ),
                <Button
                  key="close"
                  type="primary"
                  onClick={() => setDetailItem(null)}
                >
                  完成
                </Button>,
              ]
            : null
        }
        onCancel={() => setDetailItem(null)}
      >
        {detailItem && (
          <div className={styles.photoDetail}>
            <img src={detailItem.dataUrl} alt={detailItem.name} />
            <div className={styles.photoLocation}>
              <MapPinned size={17} />
              <span>
                {locationLabel(detailItem.location)}
                <small>
                  {detailItem.location?.source === "exif"
                    ? "照片 GPS"
                    : detailItem.location
                    ? `AI 识别 · ${Math.round(
                        (detailItem.location.confidence || 0) * 100,
                      )}%`
                    : "无定位"}
                </small>
              </span>
            </div>
            {detailItem.analysis?.description && (
              <Typography.Paragraph>
                {detailItem.analysis.description}
              </Typography.Paragraph>
            )}
            {!!detailItem.analysis?.tags.length && (
              <Space wrap>
                {detailItem.analysis.tags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Space>
            )}
            {!!detailItem.analysis?.visibleText.length && (
              <Typography.Paragraph type="secondary">
                画面文字：{detailItem.analysis.visibleText.join("、")}
              </Typography.Paragraph>
            )}
            {detailItem.analysisError && (
              <Alert
                type="warning"
                showIcon
                message={detailItem.analysisError}
              />
            )}
          </div>
        )}
      </Modal>
    </section>
  );
}

function LocalLensGoPage({
  settings,
  configured,
}: {
  settings: MobileSettings | null;
  configured: boolean;
}) {
  const navigate = useNavigate();
  const [memory, setMemory] = useState(loadMemory);
  const [pose, setPose] = useState("");
  const [generating, setGenerating] = useState(false);
  const [albumCount, setAlbumCount] = useState(0);
  const trips = useMemo(loadTrips, []);

  useEffect(() => {
    void listAlbumItems().then((items) => setAlbumCount(items.length));
  }, []);

  const generatePose = async () => {
    if (!configured) {
      navigate("/local/settings");
      return;
    }
    if (!settings?.imageModel) {
      message.warning("请先在设置中填写图片模型");
      navigate("/local/settings");
      return;
    }
    const subject = pose.trim() || "游客在澳门大三巴牌坊前自然站立拍照";
    setGenerating(true);
    try {
      const prompt = `旅行摄影姿势参考图，地点澳门，${subject}。全身构图，动作自然易模仿，真实摄影风格，背景清晰但不喧宾夺主，安全站位，无文字无水印。`;
      const result = await generateMobileImage(prompt);
      await putAlbumItem({
        id: createId("pose"),
        name: `姿势参考图-${new Date().toLocaleString()}`,
        dataUrl: result.dataUrl,
        source: "pose",
        createdAt: Date.now(),
        note: pose,
      });
      setAlbumCount((value) => value + 1);
      message.success("姿势参考图已保存到本地相册");
      navigate("/local/album");
    } catch (error) {
      message.error(errorText(error));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className={styles.page}>
      <div className={styles.hero}>
        <span>
          <Glasses size={28} />
        </span>
        <div>
          <Typography.Title level={2}>LensGo 本地中心</Typography.Title>
          <Typography.Text>
            核心功能运行在这台手机，不需要电脑或云服务器
          </Typography.Text>
        </div>
      </div>
      <div className={styles.metrics}>
        <Card>
          <Statistic
            title="本地运行时"
            value="在线"
            prefix={<Smartphone size={18} />}
            valueStyle={{ color: "#0f9f6e" }}
          />
        </Card>
        <Card>
          <Statistic
            title="模型 API"
            value={configured ? "已配置" : "未配置"}
            prefix={
              configured ? <CheckCircle2 size={18} /> : <CloudOff size={18} />
            }
          />
        </Card>
        <Card>
          <Statistic
            title="本地行程"
            value={trips.length}
            prefix={<MapPinned size={18} />}
          />
        </Card>
        <Card>
          <Statistic
            title="本地图片"
            value={albumCount}
            prefix={<ImageIcon size={18} />}
          />
        </Card>
      </div>
      <Card
        className={styles.card}
        title={
          <Space>
            <Camera size={18} />
            姿势教练
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          描述地点、人物和想要的感觉，参考图会直接生成并保存到手机相册。
        </Typography.Paragraph>
        <Input.TextArea
          value={pose}
          onChange={(event) => setPose(event.target.value)}
          placeholder="例如：两个人在大三巴前，轻松自然，不挡住建筑"
          autoSize={{ minRows: 3, maxRows: 6 }}
        />
        <Button
          className={styles.blockButton}
          type="primary"
          icon={<Sparkles size={17} />}
          loading={generating}
          onClick={() => void generatePose()}
        >
          生成姿势参考图
        </Button>
      </Card>
      <Card
        className={styles.card}
        title={
          <Space>
            <Save size={18} />
            旅行记忆
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          这些信息只保存在手机中，会在后续对话时提供给 LensGo。
        </Typography.Paragraph>
        <Input.TextArea
          value={memory}
          onChange={(event) => setMemory(event.target.value)}
          placeholder="例如：我不吃辣，喜欢历史建筑，步行不宜超过 30 分钟…"
          autoSize={{ minRows: 4, maxRows: 8 }}
        />
        <Button
          className={styles.blockButton}
          icon={<Save size={17} />}
          onClick={() => {
            saveMemory(memory);
            message.success("旅行记忆已保存到手机");
          }}
        >
          保存旅行记忆
        </Button>
      </Card>
    </section>
  );
}

function LocalAppRoutes({
  settings,
  onSettings,
}: {
  settings: MobileSettings | null;
  onSettings: (settings: MobileSettings) => void;
}) {
  const configured = Boolean(
    settings?.apiBaseUrl && settings?.model && settings?.hasApiKey,
  );
  const qwenpawConfigured = Boolean(
    settings?.qwenpawBaseUrl && settings?.qwenpawAgentId,
  );
  const ready = configured || qwenpawConfigured;
  return (
    <>
      <main className={styles.content}>
        <Routes>
          <Route
            path="/"
            element={
              <Navigate
                to={ready ? "/local/lensgo" : "/local/settings"}
                replace
              />
            }
          />
          <Route
            path="/local/lensgo"
            element={
              <LocalLensGoPage settings={settings} configured={configured} />
            }
          />
          <Route
            path="/local/chat"
            element={
              <LocalChatPage
                settings={settings}
                fallbackConfigured={configured}
              />
            }
          />
          <Route
            path="/local/travel"
            element={<LocalTravelPage configured={configured} />}
          />
          <Route path="/local/bills" element={<HotelBillsPage />} />
          <Route
            path="/local/album"
            element={<LocalAlbumPage configured={configured} />}
          />
          <Route
            path="/local/settings"
            element={
              <LocalSettingsPage settings={settings} onSettings={onSettings} />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <LocalNavigation />
    </>
  );
}

export default function MobileLocalApp() {
  const [settings, setSettings] = useState<MobileSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMobileSettings()
      .then(setSettings)
      .catch((error) => message.error(errorText(error)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#ff7f16",
          borderRadius: 14,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
        },
      }}
    >
      <AntdApp>
        <div className={styles.app}>
          <ProductHeader />
          {loading ? (
            <div className={styles.splash}>
              <span>
                <Glasses size={26} />
              </span>
              <Typography.Title level={3}>LensGo 澳门旅游助手</Typography.Title>
              <Spin size="small" />
            </div>
          ) : (
            <BrowserRouter>
              <LocalAppRoutes settings={settings} onSettings={setSettings} />
            </BrowserRouter>
          )}
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
