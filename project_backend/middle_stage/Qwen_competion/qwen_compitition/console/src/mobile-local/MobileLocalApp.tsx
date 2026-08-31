import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  ConfigProvider,
  Drawer,
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
  ArrowRight,
  Bot,
  Camera,
  CheckCircle2,
  CircleUserRound,
  Cloud,
  CloudOff,
  CloudUpload,
  EllipsisVertical,
  Glasses,
  Image as ImageIcon,
  ImagePlus,
  Images,
  KeyRound,
  History,
  LocateFixed,
  Map as MapIcon,
  MapPinned,
  MessageCircle,
  MessageSquarePlus,
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
  X,
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
  createId,
  deleteAlbumItem,
  deleteCloudAlbumItem,
  extractPhotoMetadata,
  fetchQwenPawLatestItinerary,
  fileToDataUrl,
  generateMobileImage,
  listAlbumItems,
  listChatMediaItems,
  listMobileModels,
  loadMemory,
  loadMobileSettings,
  loadPrivacySettings,
  loadTrips,
  mobileDeviceId,
  mobileChat,
  locationLabel,
  putAlbumItem,
  putChatMediaItem,
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
  type ChatMediaItem,
  type LocalMessage,
  type LocalTrip,
  type MobileSettings,
  type MobileSettingsInput,
  type MobilePrivacySettings,
  type TripPosition,
  type TripStop,
} from "./runtime";
import {
  announceTripUpdate,
  crowdCatalogForPrompt,
  crowdSnapshot,
  extractTripPlan,
  fetchCrowdPlaces,
  geolocationErrorMessage,
  inferStopsFromMarkdown,
  loadCrowdServiceConfig,
  locateTripStop,
  reorderRemainingStops,
  requestInitialTripPosition,
  revisedTripMarkdown,
  saveCrowdServiceConfig,
  toTripPosition,
  type CrowdPlace,
  type CrowdServiceConfig,
} from "./tripJourney";
import AlbumMap from "./AlbumMap";
import HotelBillsPage from "./HotelBillsPage";
import TripRouteMap from "./TripRouteMap";
import { streamQwenPawChat } from "./qwenpaw";
import {
  CHAT_SESSIONS_KEY,
  ACTIVE_CHAT_SESSION_KEY,
  CHAT_SESSIONS_CHANGED,
  QWENPAW_MODEL_ID,
  createChatRemoteSessionId,
  createChatSession,
  loadChatSessionState,
  updateChatSessions,
  type LocalChatSession,
} from "./chatSessions";
import {
  GUIDE_OPEN_EVENT,
  GUIDE_POSITION_EVENT,
  GUIDE_ERROR_EVENT,
  TRIPS_CHANGED_EVENT,
  GUIDE_OPTIONS,
  GUIDE_DEPARTURE_EVENT,
} from "./tripGuide";
import { startTripGuideRuntime, replyToTripGuide } from "./tripGuideRuntime";
import {
  departureChoices,
  departureGuidePlaces,
  fallbackDepartureOrigin,
  locateDepartureOrigin,
} from "./tripDeparture";
import TripDepartureChoices from "./TripDepartureChoices";
import { deleteTripAndBills } from "./tripDeletion";
import {
  extractAgentTripProposal,
  proposalFromRemoteItinerary,
  remoteItinerarySignature,
  stripAgentControlContent,
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
const POSE_PREVIEW_PATTERN =
  /(?:生成|制作|做一张|看看|预览).{0,18}(?:姿势|拍照效果|参考图)|(?:姿势|拍照效果|参考图).{0,18}(?:生成|制作|预览)/;
const CHAT_POSE_DRAFT_KEY = "lensgo_mobile_chat_pose_draft_v1";

function posePreviewPrompt(description: string): string {
  return `旅行摄影姿势效果预览，${description}。生成一张写实照片，人物全身或大半身构图，动作自然且容易模仿，站位安全，背景清晰，无文字无水印。`;
}

function sceneCompositePrompt(description: string): string {
  return `把上传的现场照片作为唯一背景参考。严格保持原照片的建筑、景物、视角、构图、光线和环境不变，不添加、删除或移动任何背景元素。只在画面中安全且适合拍照的位置新增一位写实游客，并让人物完成这个姿势：${
    description || "自然、轻松、容易模仿的旅行拍照姿势"
  }。人物比例、透视、阴影和现场光线必须真实协调，不遮挡主要地标，不添加文字或水印。`;
}

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
            extra="留空则使用上面的文字 API 地址；自动兼容阿里云 Qwen Image 多模态接口和 OpenAI Images API。"
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
  const qwenpawConfigured = Boolean(
    settings?.qwenpawBaseUrl && settings?.qwenpawAgentId,
  );
  const defaultModel = qwenpawConfigured
    ? QWENPAW_MODEL_ID
    : settings?.model || "";
  const [initialChatState] = useState(() => {
    const state = loadChatSessionState(defaultModel);
    localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(state.sessions));
    return state;
  });
  const [sessions, setSessionsState] = useState<LocalChatSession[]>(
    initialChatState.sessions,
  );
  const setSessions = (
    update:
      | LocalChatSession[]
      | ((current: LocalChatSession[]) => LocalChatSession[]),
  ) => {
    updateChatSessions((current) =>
      typeof update === "function" ? update(current) : update,
    );
  };
  useEffect(() => {
    const refresh = () =>
      setSessionsState(loadChatSessionState(defaultModel, true).sessions);
    window.addEventListener(CHAT_SESSIONS_CHANGED, refresh);
    refresh();
    return () => window.removeEventListener(CHAT_SESSIONS_CHANGED, refresh);
  }, [defaultModel]);
  const [activeSessionId, setActiveSessionId] = useState(
    initialChatState.activeId,
  );
  const [input, setInput] = useState(() => {
    const draft = localStorage.getItem(CHAT_POSE_DRAFT_KEY) || "";
    localStorage.removeItem(CHAT_POSE_DRAFT_KEY);
    return draft;
  });
  const [sending, setSending] = useState(false);
  const [agentActivity, setAgentActivity] = useState("");
  const [albumItems, setAlbumItems] = useState<AlbumItem[]>([]);
  const [chatMediaItems, setChatMediaItems] = useState<ChatMediaItem[]>([]);
  const [pendingImage, setPendingImage] = useState<{
    name: string;
    dataUrl: string;
  } | null>(null);
  const [apiModels, setApiModels] = useState<string[]>(
    settings?.model ? [settings.model] : [],
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) || sessions[0];
  const messages = activeSession?.messages || [];
  const selectedModel = activeSession?.model || defaultModel;
  const qwenpawSelected = selectedModel === QWENPAW_MODEL_ID;
  const modelOptions = useMemo(
    () => [
      ...(qwenpawConfigured
        ? [{ value: QWENPAW_MODEL_ID, label: "QwenPaw 主智能体" }]
        : []),
      ...apiModels.map((model) => ({ value: model, label: model })),
    ],
    [apiModels, qwenpawConfigured],
  );
  const albumById = useMemo(
    () => new Map(albumItems.map((item) => [item.id, item])),
    [albumItems],
  );
  const chatMediaById = useMemo(
    () => new Map(chatMediaItems.map((item) => [item.id, item])),
    [chatMediaItems],
  );

  const setMessages = (
    update: LocalMessage[] | ((current: LocalMessage[]) => LocalMessage[]),
  ) => {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== activeSessionId) return session;
        const nextMessages =
          typeof update === "function" ? update(session.messages) : update;
        const firstQuestion = nextMessages.find((item) => item.role === "user")
          ?.content;
        return {
          ...session,
          title:
            session.title === "新对话" && firstQuestion
              ? firstQuestion.trim().slice(0, 24)
              : session.title,
          messages: nextMessages,
          updatedAt: Date.now(),
        };
      }),
    );
  };

  useEffect(() => {
    localStorage.setItem(ACTIVE_CHAT_SESSION_KEY, activeSessionId);
    saveMessages(messages);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeSessionId, messages, sessions]);

  useEffect(() => {
    if (!settings?.hasApiKey || !settings.apiBaseUrl) return;
    setModelsLoading(true);
    void listMobileModels()
      .then((models) => {
        const next = Array.from(
          new Set([settings.model, ...models].filter(Boolean)),
        );
        setApiModels(next);
      })
      .catch(() => {
        setApiModels(settings.model ? [settings.model] : []);
      })
      .finally(() => setModelsLoading(false));
  }, [settings?.apiBaseUrl, settings?.hasApiKey, settings?.model]);

  useEffect(() => {
    void listAlbumItems().then(setAlbumItems);
    void listChatMediaItems().then(setChatMediaItems);
  }, []);

  useEffect(() => {
    void listChatMediaItems().then(setChatMediaItems);
  }, [messages]);

  useEffect(() => {
    const open = (event: Event) => {
      if (sending || input.trim()) return;
      setActiveSessionId((event as CustomEvent<string>).detail);
      setHistoryOpen(false);
    };
    window.addEventListener(GUIDE_OPEN_EVENT, open);
    return () => window.removeEventListener(GUIDE_OPEN_EVENT, open);
  }, [sending, input]);

  const send = async (preset?: string) => {
    const sourceImage = pendingImage;
    const text = (preset ?? input).trim();
    if ((!text && !sourceImage) || sending) return;
    const visibleText =
      text || "请保持现场背景不变，生成自然的旅行拍照姿势效果预览。";
    const imageTask = Boolean(sourceImage) || POSE_PREVIEW_PATTERN.test(text);
    if (activeSession?.guide?.status === "loading") {
      message.info("景点故事正在讲解，请稍候再追问");
      return;
    }
    if (
      imageTask &&
      (!settings?.imageModel ||
        !(settings.hasImageApiKey || settings.hasApiKey))
    ) {
      message.warning("请先在设置中配置图片模型和图片 API Key");
      navigate("/local/settings");
      return;
    }
    if (
      !imageTask &&
      (qwenpawSelected ? !qwenpawConfigured : !fallbackConfigured)
    ) {
      message.warning(
        qwenpawSelected ? "请先配置 QwenPaw 服务" : "请先配置模型 API",
      );
      navigate("/local/settings");
      return;
    }
    let sourceMedia: ChatMediaItem | undefined;
    if (sourceImage) {
      sourceMedia = {
        id: createId("chat-source"),
        name: sourceImage.name,
        dataUrl: sourceImage.dataUrl,
        kind: "source",
        createdAt: Date.now(),
      };
      await putChatMediaItem(sourceMedia);
      setChatMediaItems((current) => [...current, sourceMedia!]);
    }
    const userMessage: LocalMessage = {
      id: createId("message"),
      role: "user",
      content: visibleText,
      createdAt: Date.now(),
      chatMediaId: sourceMedia?.id,
      chatMediaKind: sourceMedia ? "source" : undefined,
    };
    const next = [...messages, userMessage];
    setMessages(next);
    setInput("");
    setPendingImage(null);
    setSending(true);
    setAgentActivity(
      imageTask
        ? sourceMedia
          ? "正在保持现场背景并合成人物姿势…"
          : "正在生成姿势效果预览…"
        : qwenpawSelected
        ? "正在连接 QwenPaw 主智能体…"
        : `正在连接 ${selectedModel}…`,
    );
    let guideReplyId: string | undefined;
    try {
      if (imageTask) {
        const result = await generateMobileImage(
          sourceMedia
            ? sceneCompositePrompt(text)
            : posePreviewPrompt(visibleText),
          "1024x1024",
          sourceMedia?.dataUrl,
        );
        const preview: ChatMediaItem = {
          id: createId("chat-preview"),
          name: sourceMedia
            ? `现场拍照效果-${new Date().toLocaleString()}`
            : `姿势参考图-${new Date().toLocaleString()}`,
          dataUrl: result.dataUrl,
          kind: "preview",
          createdAt: Date.now(),
          sourceMediaId: sourceMedia?.id,
        };
        await putChatMediaItem(preview);
        setChatMediaItems((current) => [...current, preview]);
        setMessages((current) => [
          ...current,
          {
            id: createId("message"),
            role: "assistant",
            content: sourceMedia
              ? "这是以你上传的现场照片为背景生成的拍照效果预览。满意后再保存到相册。"
              : "姿势效果预览已经生成。满意后再保存到相册。",
            chatMediaId: preview.id,
            chatMediaKind: "preview",
            createdAt: Date.now(),
          },
        ]);
        return;
      }
      if (activeSession?.guide) {
        guideReplyId = createId("message");
        const replyId = guideReplyId;
        setMessages((current) => [
          ...current,
          {
            id: replyId,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
          },
        ]);
        const reply = await replyToTripGuide(
          activeSession,
          text,
          (content) =>
            setMessages((current) =>
              current.map((item) =>
                item.id === replyId ? { ...item, content } : item,
              ),
            ),
          setAgentActivity,
        );
        setMessages((current) =>
          current.map((item) =>
            item.id === replyId ? { ...item, content: reply } : item,
          ),
        );
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id
              ? {
                  ...session,
                  guide: { ...session.guide!, status: "ready" },
                }
              : session,
          ),
        );
        return;
      }
      // The legacy direct-model fallback may search the on-device album.
      // QwenPaw mode deliberately skips this branch: local-only photos must
      // remain invisible to the main agent until the user uploads them.
      if (!qwenpawSelected && PHOTO_SEARCH_PATTERN.test(text)) {
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
      if (qwenpawSelected) {
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
            sessionId:
              activeSession?.remoteSessionId || createChatRemoteSessionId(),
            userId: mobileDeviceId(),
            deviceId: mobileDeviceId(),
            context,
          },
          {
            onText: (content) =>
              setMessages((current) =>
                current.map((item) =>
                  item.id === assistantId
                    ? {
                        ...item,
                        content: stripAgentControlContent(content),
                      }
                    : item,
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
        const visibleContent = stripAgentControlContent(finalContent);
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId
              ? {
                  ...item,
                  content:
                    visibleContent ||
                    (proposal
                      ? "行程方案已生成，请确认是否保存到“旅程”。"
                      : "处理已完成。"),
                }
              : item,
          ),
        );
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
        const response = await mobileChat(requestMessages, {
          model: selectedModel,
        });
        setMessages((current) => [
          ...current,
          {
            id: createId("message"),
            role: "assistant",
            content:
              stripAgentControlContent(response.content) || "处理已完成。",
            createdAt: Date.now(),
          },
        ]);
      }
    } catch (error) {
      if (guideReplyId) {
        const replyId = guideReplyId;
        setMessages((current) =>
          current.map((item) =>
            item.id === replyId
              ? {
                  ...item,
                  content:
                    "本次导览请求未完成，请稍后重试。已有聊天和旅程已保留。",
                }
              : item,
          ),
        );
      }
      message.error(errorText(error));
    } finally {
      setSending(false);
      setAgentActivity("");
    }
  };

  const selectChatImage = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      setPendingImage({ name: file.name, dataUrl: await fileToDataUrl(file) });
      if (!input.trim()) {
        setInput("请保持现场背景不变，在合适位置加入一位自然摆姿势的游客。");
      }
    } catch (error) {
      message.error(errorText(error));
    } finally {
      if (chatImageInputRef.current) chatImageInputRef.current.value = "";
    }
  };

  const saveChatPreview = async (item: LocalMessage) => {
    if (!item.chatMediaId || item.savedAlbumItemId) return;
    const media = chatMediaById.get(item.chatMediaId);
    if (!media) {
      message.error("预览图片已不可用，请重新生成");
      return;
    }
    const albumId = createId("pose");
    await putAlbumItem({
      id: albumId,
      name: media.name,
      dataUrl: media.dataUrl,
      source: "pose",
      createdAt: Date.now(),
      note: item.content,
      syncStatus: "local",
    });
    setMessages((current) =>
      current.map((messageItem) =>
        messageItem.id === item.id
          ? { ...messageItem, savedAlbumItemId: albumId }
          : messageItem,
      ),
    );
    setAlbumItems(await listAlbumItems());
    message.success("效果预览已保存到本地相册");
  };

  const newChat = () => {
    const session = createChatSession(selectedModel || defaultModel);
    setSessions((current) => [session, ...current].slice(0, 50));
    setActiveSessionId(session.id);
    setInput("");
    setHistoryOpen(false);
  };

  const selectChat = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setInput("");
    setHistoryOpen(false);
  };

  const deleteChat = (sessionId: string) => {
    const remaining = sessions.filter((session) => session.id !== sessionId);
    if (remaining.length) {
      setSessions(remaining);
      if (sessionId === activeSessionId) {
        setActiveSessionId(remaining[0].id);
      }
      return;
    }
    const replacement = createChatSession(defaultModel);
    setSessions([replacement]);
    setActiveSessionId(replacement.id);
  };

  const selectModel = (model: string) => {
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSessionId
          ? { ...session, model, updatedAt: Date.now() }
          : session,
      ),
    );
  };

  return (
    <section className={styles.chatPage}>
      <header className={styles.chatToolbar}>
        <strong>对话</strong>
        <div className={styles.chatToolbarActions}>
          <Select
            className={styles.chatModelSelect}
            value={selectedModel || undefined}
            placeholder="选择模型"
            options={modelOptions}
            loading={modelsLoading}
            disabled={sending}
            showSearch={modelOptions.length > 6}
            popupMatchSelectWidth={false}
            optionFilterProp="label"
            onChange={selectModel}
          />
          <Button
            type="text"
            className={styles.chatToolbarButton}
            icon={<MessageSquarePlus size={20} />}
            disabled={sending}
            aria-label="新建聊天"
            title="新建聊天"
            onClick={newChat}
          />
          <Button
            type="text"
            className={styles.chatToolbarButton}
            icon={<EllipsisVertical size={21} />}
            disabled={sending}
            aria-label="历史对话"
            title="历史对话"
            onClick={() => setHistoryOpen(true)}
          />
        </div>
      </header>

      <div className={styles.chatScrollArea}>
        {qwenpawSelected && !qwenpawConfigured && (
          <Alert
            showIcon
            type="warning"
            message="尚未配置 QwenPaw"
            action={
              <Button size="small" onClick={() => navigate("/local/settings")}>
                去设置
              </Button>
            }
          />
        )}
        {!qwenpawSelected && !fallbackConfigured && (
          <Alert
            showIcon
            type="warning"
            message="尚未配置模型 API"
            action={
              <Button size="small" onClick={() => navigate("/local/settings")}>
                去设置
              </Button>
            }
          />
        )}
        {qwenpawSelected &&
          qwenpawConfigured &&
          !loadPrivacySettings().shareTripsWithAgent && (
            <Alert
              className={styles.chatPrivacyAlert}
              showIcon
              type="info"
              message="主智能体当前看不到本地旅程"
            />
          )}

        {messages.length === 0 ? (
          <div className={styles.chatWelcome}>
            <div className={styles.chatWelcomeAvatar}>
              <Bot size={42} strokeWidth={1.6} />
            </div>
            <h2>你好，我今天能帮你做什么？</h2>
            <p>我是 LensGo 智能助手，可以帮你解答澳门旅行问题。</p>
            <div className={styles.chatSuggestions}>
              {[
                "让我们开启一段新的旅程吧！",
                "能告诉我你有哪些旅行技能吗？",
                "生成一张大三巴拍照姿势预览图",
              ].map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  disabled={sending}
                  onClick={() => void send(prompt)}
                >
                  <Sparkles size={17} />
                  <span>{prompt}</span>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.messages}>
            {messages.map((item) => {
              const chatMedia = item.chatMediaId
                ? chatMediaById.get(item.chatMediaId)
                : undefined;
              return (
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
                    <ReactMarkdown
                      components={
                        activeSession?.guide && item.role === "assistant"
                          ? {
                              a: ({
                                node: _node,
                                href,
                                children,
                                ...props
                              }) => {
                                const match = href?.match(
                                  /^#lensgo-guide-([1-6])$/,
                                );
                                return (
                                  <a
                                    {...props}
                                    href={href}
                                    onClick={
                                      match
                                        ? (event) => {
                                            event.preventDefault();
                                            void send(
                                              GUIDE_OPTIONS[
                                                Number(match[1]) - 1
                                              ],
                                            );
                                          }
                                        : undefined
                                    }
                                  >
                                    {children}
                                  </a>
                                );
                              },
                            }
                          : undefined
                      }
                    >
                      {item.content}
                    </ReactMarkdown>
                    {chatMedia && (
                      <div className={styles.chatMediaCard}>
                        <img src={chatMedia.dataUrl} alt={chatMedia.name} />
                        {item.chatMediaKind === "preview" && (
                          <div className={styles.chatMediaActions}>
                            <span>
                              {item.savedAlbumItemId
                                ? "已保存到相册"
                                : "仅在对话中预览"}
                            </span>
                            <Button
                              size="small"
                              type={
                                item.savedAlbumItemId ? "default" : "primary"
                              }
                              icon={<Save size={15} />}
                              disabled={Boolean(item.savedAlbumItemId)}
                              onClick={() => void saveChatPreview(item)}
                            >
                              {item.savedAlbumItemId ? "已保存" : "保存到相册"}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
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
              );
            })}
          </div>
        )}
        {sending && (
          <div className={styles.thinking}>
            <Spin size="small" /> {agentActivity || "LensGo 正在思考…"}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className={styles.chatComposer}>
        <input
          ref={chatImageInputRef}
          hidden
          type="file"
          accept="image/*"
          onChange={(event) => void selectChatImage(event.target.files)}
        />
        {pendingImage && (
          <div className={styles.chatPendingImage}>
            <img src={pendingImage.dataUrl} alt={pendingImage.name} />
            <div>
              <strong>{pendingImage.name}</strong>
              <span>将保留这张图的背景，合成人物与拍照姿势</span>
            </div>
            <Button
              type="text"
              shape="circle"
              icon={<X size={17} />}
              aria-label="移除图片"
              onClick={() => setPendingImage(null)}
            />
          </div>
        )}
        <Input.TextArea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          autoSize={{ minRows: 2, maxRows: 5 }}
          maxLength={10000}
          placeholder="输入消息，或上传现场照片生成拍照效果…"
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className={styles.chatComposerFooter}>
          <div className={styles.chatComposerTools}>
            <Button
              type="text"
              shape="circle"
              icon={<ImagePlus size={19} />}
              disabled={sending}
              aria-label="上传现场照片"
              title="上传现场照片"
              onClick={() => chatImageInputRef.current?.click()}
            />
            <span>{input.length}/10000</span>
          </div>
          <Button
            type="primary"
            shape="circle"
            icon={<Send size={18} />}
            loading={sending}
            disabled={!input.trim() && !pendingImage}
            aria-label="发送消息"
            onClick={() => void send()}
          />
        </div>
      </div>

      <Drawer
        className={styles.chatHistoryDrawer}
        title={
          <span className={styles.chatHistoryTitle}>
            <History size={18} /> 历史对话
          </span>
        }
        placement="right"
        width="88%"
        open={historyOpen}
        extra={
          <Button
            type="text"
            icon={<MessageSquarePlus size={18} />}
            onClick={newChat}
          >
            新建
          </Button>
        }
        onClose={() => setHistoryOpen(false)}
      >
        <div className={styles.chatHistoryList}>
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`${styles.chatHistoryItem} ${
                session.id === activeSessionId
                  ? styles.chatHistoryItemActive
                  : ""
              }`}
            >
              <button type="button" onClick={() => selectChat(session.id)}>
                <strong>{session.title}</strong>
                <span>
                  {session.messages[session.messages.length - 1]?.content ||
                    "还没有消息"}
                </span>
                <small>
                  {new Date(session.updatedAt).toLocaleString([], {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </small>
              </button>
              <Button
                type="text"
                danger
                icon={<Trash2 size={16} />}
                aria-label={`删除${session.title}`}
                onClick={() => deleteChat(session.id)}
              />
            </div>
          ))}
        </div>
      </Drawer>
    </section>
  );
}

function LocalTravelPage({ configured }: { configured: boolean }) {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [trips, setTrips] = useState<LocalTrip[]>(loadTrips);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedDay, setSelectedDay] = useState<"overview" | number>(
    "overview",
  );
  const [selected, setSelected] = useState<LocalTrip | null>(
    trips.find((trip) => trip.status === "active") || trips[0] || null,
  );
  const [crowdPlaces, setCrowdPlaces] = useState<CrowdPlace[]>([]);
  const [crowdLoading, setCrowdLoading] = useState(false);
  const [crowdError, setCrowdError] = useState("");
  const [positionText, setPositionText] = useState("等待开启行程");
  const [replanning, setReplanning] = useState(false);
  const [deletingTripId, setDeletingTripId] = useState("");
  const selectedRef = useRef<LocalTrip | null>(selected);
  const crowdPlacesRef = useRef<CrowdPlace[]>(crowdPlaces);
  const lastCrowdFetchRef = useRef(0);
  const departureVersionRef = useRef(0);
  const departureTripRef = useRef("");
  const travelMountedRef = useRef(true);
  const crowdReminderRef = useRef<ReturnType<typeof Modal.confirm> | null>(
    null,
  );

  useEffect(() => {
    travelMountedRef.current = true;
    const refresh = () => {
      const latest = loadTrips();
      setTrips(latest);
      const current =
        latest.find((trip) => trip.id === selectedRef.current?.id) || null;
      if (
        departureTripRef.current &&
        (current?.id !== departureTripRef.current ||
          current.status !== "active")
      ) {
        departureVersionRef.current += 1;
        departureTripRef.current = "";
        crowdReminderRef.current?.destroy();
        window.dispatchEvent(
          new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: false }),
        );
      }
      selectedRef.current = current;
      setSelected(current);
    };
    window.addEventListener(TRIPS_CHANGED_EVENT, refresh);
    return () => {
      travelMountedRef.current = false;
      departureVersionRef.current += 1;
      crowdReminderRef.current?.destroy();
      window.dispatchEvent(
        new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: false }),
      );
      window.removeEventListener(TRIPS_CHANGED_EVENT, refresh);
    };
  }, []);

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
    const next = loadTrips().map((trip) =>
      trip.id === tripId ? updater(trip) : trip,
    );
    const updated = next.find((trip) => trip.id === tripId) || null;
    selectedRef.current = updated;
    setSelected(updated);
    setTrips(next);
    saveTrips(next);
  };

  const confirmDeleteTrip = (trip: LocalTrip) => {
    Modal.confirm({
      title: "删除整个行程？",
      icon: <Trash2 size={22} color="#d94c42" />,
      content:
        "该行程及“账单”栏目中与它关联的全部费用会一起删除，删除后无法恢复。对话记录不会受到影响。",
      okText: "删除行程和账单",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingTripId(trip.id);
        try {
          const { remainingTrips, removedExpenseCount } =
            await deleteTripAndBills(trip.id);
          const nextSelected =
            remainingTrips.find((item) => item.status === "active") ||
            remainingTrips[0] ||
            null;
          setTrips(remainingTrips);
          setSelected(nextSelected);
          selectedRef.current = nextSelected;
          setSelectedDay("overview");
          if (trip.status === "active") {
            setPositionText("行程已删除，位置跟踪已停止");
          }
          message.success(
            removedExpenseCount
              ? `行程已删除，并同步删除 ${removedExpenseCount} 笔账单`
              : "行程已删除；该行程没有关联账单",
          );
        } catch (error) {
          message.error(`删除失败，行程已保留：${errorText(error)}`);
        } finally {
          setDeletingTripId("");
        }
      },
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
      setPlannerOpen(false);
      setSelectedDay("overview");
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

  const showDepartureChoices = async (
    trip: LocalTrip,
    position: TripPosition,
  ) => {
    if (
      !travelMountedRef.current ||
      selectedRef.current?.id !== trip.id ||
      selectedRef.current.status !== "active"
    )
      return;
    const version = ++departureVersionRef.current;
    departureTripRef.current = trip.id;
    window.dispatchEvent(
      new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: true }),
    );
    crowdReminderRef.current?.destroy();
    const close = () => {
      if (departureVersionRef.current !== version) return;
      departureVersionRef.current += 1;
      departureTripRef.current = "";
      crowdReminderRef.current?.destroy();
      crowdReminderRef.current = null;
      window.dispatchEvent(
        new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: false }),
      );
    };
    crowdReminderRef.current = Modal.confirm({
      title: "接下来想去哪里？",
      icon: <LocateFixed size={22} color="#ff7f16" />,
      content: (
        <div className={styles.reminderContent}>
          <Spin size="small" /> 正在识别出发地、查询附近景点人流…
        </div>
      ),
      okText: "先自由走走",
      cancelText: "关闭",
      onOk: close,
      onCancel: close,
    });
    const [places, origin] = await Promise.all([
      refreshCrowd(true),
      locateDepartureOrigin(position, crowdPlacesRef.current),
    ]);
    if (
      !travelMountedRef.current ||
      selectedRef.current?.id !== trip.id ||
      selectedRef.current.status !== "active" ||
      selectedRef.current.startedAt !== trip.startedAt
    )
      return;
    const current = selectedRef.current;
    replaceTrip(trip.id, (latest) => ({
      ...latest,
      guidePlaces: departureGuidePlaces(latest, places),
    }));
    if (departureVersionRef.current !== version) return;
    const choose = (stop: TripStop) => {
      if (
        departureVersionRef.current !== version ||
        selectedRef.current?.status !== "active" ||
        selectedRef.current.id !== trip.id
      )
        return;
      replaceTrip(trip.id, (latest) => ({ ...latest, guideDestination: stop }));
      close();
      message.success(`已选择${stop.name}，到达后将自动讲解；你也可以自由走动`);
    };
    crowdReminderRef.current?.update({
      content: (
        <div className={styles.reminderContent}>
          <TripDepartureChoices
            origin={
              origin.available
                ? origin
                : fallbackDepartureOrigin(position, places)
            }
            choices={departureChoices(current, position, places)}
            onChoose={choose}
          />
        </div>
      ),
    });
  };

  const handlePosition = async (tripId: string, position: TripPosition) => {
    const trip = selectedRef.current;
    if (!trip || trip.id !== tripId || trip.status !== "active") return;
    const located = locateTripStop(trip, position);
    setPositionText(
      located
        ? `已到达 ${
            trip.stops?.[located.index]?.name || "行程地点"
          } · 误差约 ${Math.round(position.accuracy)} 米`
        : `定位正常 · 误差约 ${Math.round(position.accuracy)} 米`,
    );
    if (
      !crowdPlacesRef.current.length ||
      Date.now() - lastCrowdFetchRef.current > 2 * 60_000
    ) {
      await refreshCrowd(true);
    }
  };

  useEffect(() => {
    if (selected?.status !== "active") return;
    setPositionText("正在获取手机位置…");
    const positionListener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ tripId: string; position: TripPosition }>
      ).detail;
      if (detail.tripId === selected.id)
        void handlePosition(detail.tripId, detail.position);
    };
    const errorListener = (event: Event) => {
      setPositionText(String((event as CustomEvent<string>).detail));
    };
    window.addEventListener(GUIDE_POSITION_EVENT, positionListener);
    window.addEventListener(GUIDE_ERROR_EVENT, errorListener);
    return () => {
      window.removeEventListener(GUIDE_POSITION_EVENT, positionListener);
      window.removeEventListener(GUIDE_ERROR_EVENT, errorListener);
    };
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
        "开启后 LensGo 才会读取手机位置，并通过地图服务识别附近酒店或地标，询问你想去哪里、展示附近景点人流。之后按实际位置触发讲解，不要求按行程顺序。未开启的规划不会跟踪位置。",
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
          if (
            !travelMountedRef.current ||
            selectedRef.current?.id !== selected.id
          )
            return;
          // The chooser owns this short pause; GPS continues, but an arrival
          // story must not steal the screen while the visitor is choosing.
          window.dispatchEvent(
            new CustomEvent(GUIDE_DEPARTURE_EVENT, { detail: true }),
          );
          const currentIndex = -1;
          const next = loadTrips().map((trip) => {
            if (trip.id === selected.id) {
              return {
                ...trip,
                stops,
                status: "active" as const,
                currentStopIndex: currentIndex,
                startedAt: Date.now(),
                completedAt: undefined,
                lastPosition: position,
                guideDestination: undefined,
                guidePlaces: departureGuidePlaces(trip, crowdPlacesRef.current),
              };
            }
            return trip.status === "active"
              ? { ...trip, status: "planned" as const }
              : trip;
          });
          const active = next.find((trip) => trip.id === selected.id) || null;
          setSelected(active);
          selectedRef.current = active;
          setTrips(next);
          saveTrips(next);
          announceTripUpdate(
            "行程已开始",
            `${selected.title}已开始，请根据当前位置选择想去的地方，也可以自由走动。`,
          );
          message.success("行程已开始，位置跟踪已开启");
          if (active) void showDepartureChoices(active, position);
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
  const nextStop =
    selected?.guideDestination ||
    (selected?.status === "active"
      ? { id: "guide-unselected", name: "未选择，可自由走动" }
      : undefined);
  const nextCrowd = nextStop ? crowdSnapshot(nextStop, crowdPlaces) : undefined;
  const dayNumbers = Array.from(
    new Set((selected?.stops || []).map((stop) => stop.day || 1)),
  ).sort((left, right) => left - right);
  const visibleStopEntries = (selected?.stops || [])
    .map((stop, originalIndex) => ({ stop, originalIndex }))
    .filter(
      ({ stop }) =>
        selectedDay === "overview" || (stop.day || 1) === selectedDay,
    );
  const scopedTrip = selected
    ? {
        ...selected,
        stops: visibleStopEntries.map(({ stop }) => stop),
      }
    : null;
  const scopedCurrentIndex =
    selectedDay === "overview"
      ? selectedIndex
      : visibleStopEntries.filter(
          ({ originalIndex }) => originalIndex <= selectedIndex,
        ).length - 1;
  const selectedStatus =
    selected?.status === "active"
      ? "行程进行中"
      : selected?.status === "completed"
      ? "行程已结束"
      : "行程未开始";

  return (
    <section className={`${styles.page} ${styles.journeyPage}`}>
      <AppHeader
        title="本地旅行规划"
        subtitle={
          selected?.status === "active"
            ? positionText
            : "选择行程和日期，查看地图路线与详细安排"
        }
        action={
          <Button
            className={`${styles.journeyStartButton} ${
              selected?.status === "active" ? styles.journeyStopButton : ""
            }`}
            type="primary"
            shape="circle"
            size="large"
            icon={
              selected?.status === "active" ? (
                <Square size={17} />
              ) : (
                <Play size={18} />
              )
            }
            disabled={!selected}
            aria-label={
              selected?.status === "active" ? "结束当前行程" : "开始当前行程"
            }
            title={
              selected?.status === "active" ? "结束当前行程" : "开始当前行程"
            }
            onClick={selected?.status === "active" ? finishTrip : startTrip}
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
      {selected ? (
        <>
          <div className={styles.journeySelectorCard}>
            <div className={styles.journeySectionHeading}>
              <span>行程选择</span>
              <Space size={4}>
                <Button
                  type="link"
                  size="small"
                  icon={<Sparkles size={14} />}
                  onClick={() => setPlannerOpen(true)}
                >
                  规划新行程
                </Button>
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<Trash2 size={14} />}
                  loading={deletingTripId === selected.id}
                  aria-label={`删除行程${selected.title}`}
                  onClick={() => confirmDeleteTrip(selected)}
                >
                  删除行程
                </Button>
              </Space>
            </div>
            <Select
              className={styles.journeyTripSelect}
              value={selected.id}
              suffixIcon={<MapPinned size={17} />}
              options={trips.map((trip) => ({
                value: trip.id,
                label: trip.title,
              }))}
              onChange={(tripId) => {
                const trip = trips.find((item) => item.id === tripId) || null;
                setSelected(trip);
                selectedRef.current = trip;
                setSelectedDay("overview");
              }}
            />
            <div className={styles.journeyTripMeta}>
              <Tag
                color={
                  selected.status === "active"
                    ? "processing"
                    : selected.status === "completed"
                    ? "success"
                    : "default"
                }
              >
                {selectedStatus}
              </Tag>
              <span>{selected.stops?.length || 0} 个路线点</span>
              <span>
                {new Date(
                  selected.updatedAt || selected.createdAt,
                ).toLocaleDateString()}
              </span>
            </div>
          </div>

          <div className={styles.journeyScopeTabs} aria-label="路线日期选择">
            <button
              type="button"
              className={
                selectedDay === "overview" ? styles.journeyScopeActive : ""
              }
              aria-pressed={selectedDay === "overview"}
              onClick={() => setSelectedDay("overview")}
            >
              总览
            </button>
            {dayNumbers.map((day) => (
              <button
                type="button"
                key={day}
                className={selectedDay === day ? styles.journeyScopeActive : ""}
                aria-pressed={selectedDay === day}
                onClick={() => setSelectedDay(day)}
              >
                第{day}天
              </button>
            ))}
          </div>

          <div className={styles.journeyMapCard}>
            <div className={styles.journeyMapHeader}>
              <span>
                <MapIcon size={17} />
                <strong>
                  {selectedDay === "overview"
                    ? "全部路线"
                    : `第 ${selectedDay} 天路线`}
                </strong>
              </span>
              <Button
                type="text"
                size="small"
                icon={<RefreshCw size={15} />}
                loading={crowdLoading}
                onClick={() => void refreshCrowd()}
              >
                更新客流
              </Button>
            </div>
            {scopedTrip && (
              <TripRouteMap
                trip={scopedTrip}
                currentStopIndex={scopedCurrentIndex}
              />
            )}
            <div className={styles.journeyMapFootnote}>
              路线与坐标保存在手机；选择日期可只查看当天线路
            </div>
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
                  <small>位置提醒</small>
                  <strong>已开启</strong>
                </span>
              </div>
            </div>
          )}

          <Card className={`${styles.card} ${styles.journeyDetailsCard}`}>
            <div className={styles.journeyDetailsTitle}>
              <div>
                <small>
                  {selectedDay === "overview" ? "完整安排" : "当日安排"}
                </small>
                <strong>
                  {selectedDay === "overview"
                    ? selected.title
                    : `第 ${selectedDay} 天行程`}
                </strong>
              </div>
              <span>{visibleStopEntries.length} 站</span>
            </div>
            {visibleStopEntries.length ? (
              <div className={styles.journeyRouteList}>
                {visibleStopEntries.map(
                  ({ stop, originalIndex }, displayIndex) => {
                    const snapshot = crowdSnapshot(stop, crowdPlaces);
                    return (
                      <div
                        key={stop.id}
                        className={
                          originalIndex <= selectedIndex
                            ? styles.tripStopDone
                            : originalIndex === selectedIndex + 1
                            ? styles.tripStopNext
                            : ""
                        }
                      >
                        <span className={styles.tripStopIndex}>
                          {originalIndex <= selectedIndex ? (
                            <CheckCircle2 size={16} />
                          ) : (
                            displayIndex + 1
                          )}
                        </span>
                        <div>
                          <span className={styles.journeyStopTopline}>
                            <strong>{stop.name}</strong>
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
                                  ? "数据已过期"
                                  : `${snapshot.reading.people_count} 人`}
                              </Tag>
                            )}
                          </span>
                          <small>
                            {[
                              `第 ${stop.day || 1} 天`,
                              stop.time || "时间待定",
                            ].join(" · ")}
                          </small>
                          {stop.note && <p>{stop.note}</p>}
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="该范围暂无路线点"
              />
            )}
            {selected.status === "active" && (
              <Button
                className={styles.journeyReplanButton}
                block
                icon={<Users size={16} />}
                loading={replanning}
                onClick={() => void replanTrip(selected.id)}
              >
                按实时人流更新后续行程
              </Button>
            )}
            {selectedDay === "overview" && selected.content && (
              <details className={styles.journeyFullPlan}>
                <summary>查看完整规划说明</summary>
                <div className={styles.markdownCard}>
                  <ReactMarkdown>{selected.content}</ReactMarkdown>
                </div>
              </details>
            )}
          </Card>
        </>
      ) : (
        <div className={styles.journeyEmpty}>
          <Empty description="还没有本地行程，先规划一份澳门路线" />
          <Button
            type="primary"
            icon={<Sparkles size={16} />}
            onClick={() => setPlannerOpen(true)}
          >
            规划新行程
          </Button>
        </div>
      )}

      <Modal
        title="规划新行程"
        open={plannerOpen}
        footer={null}
        onCancel={() => setPlannerOpen(false)}
      >
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
      </Modal>
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
  const [albumCount, setAlbumCount] = useState(0);
  const trips = useMemo(loadTrips, []);

  useEffect(() => {
    void listAlbumItems().then((items) => setAlbumCount(items.length));
  }, []);

  const openPoseChat = () => {
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
    localStorage.setItem(
      CHAT_POSE_DRAFT_KEY,
      `请生成一张拍照姿势效果预览图：${subject}`,
    );
    navigate("/local/chat");
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
          描述地点、人物和想要的感觉，参考图会先在对话中生成，确认满意后再保存到相册。
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
          onClick={openPoseChat}
        >
          到对话生成姿势预览
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
  const navigate = useNavigate();
  const location = useLocation();
  const currentPathRef = useRef(location.pathname);
  currentPathRef.current = location.pathname;
  useEffect(
    () => startTripGuideRuntime(settings),
    [settings?.qwenpawBaseUrl, settings?.qwenpawAgentId],
  );
  useEffect(() => {
    const open = (event: Event) => {
      // Arrival never navigates away from the other four sections.
      if (currentPathRef.current !== "/local/travel") return;
      localStorage.setItem(
        ACTIVE_CHAT_SESSION_KEY,
        (event as CustomEvent<string>).detail,
      );
      navigate("/local/chat");
    };
    window.addEventListener(GUIDE_OPEN_EVENT, open);
    return () => window.removeEventListener(GUIDE_OPEN_EVENT, open);
  }, [navigate]);
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
