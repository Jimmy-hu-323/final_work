import { useState, type ReactNode } from "react";
import { Button, Card, Form, Input, Space, Typography, message } from "antd";
import { Smartphone, Server, ShieldCheck } from "lucide-react";
import {
  getApiBaseUrl,
  getApiUrl,
  setApiBaseUrl,
} from "../api/config";
import {
  getLensGoBaseUrl,
  getLensGoToken,
  setLensGoBaseUrl,
  setLensGoToken,
} from "../api/lensgo";

type Values = {
  qwenpawBaseUrl: string;
  lensgoBaseUrl?: string;
  bridgeToken?: string;
};

export default function MobileConnectionGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!MOBILE || Boolean(getApiBaseUrl()));
  const [loading, setLoading] = useState(false);

  if (ready) return <>{children}</>;

  const connect = async (values: Values) => {
    setLoading(true);
    try {
      setApiBaseUrl(values.qwenpawBaseUrl);
      const response = await fetch(getApiUrl("/version"));
      if (!response.ok) throw new Error(`QwenPaw 返回 HTTP ${response.status}`);
      setLensGoBaseUrl(values.lensgoBaseUrl || "");
      setLensGoToken(values.bridgeToken || "");
      setReady(true);
    } catch (error) {
      setApiBaseUrl("");
      message.error(
        error instanceof Error
          ? `无法连接服务器：${error.message}`
          : "无法连接服务器",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom))",
        background: "linear-gradient(150deg, #fff8f1 0%, #f5f7ff 54%, #effaf8 100%)",
      }}
    >
      <Card style={{ width: "min(100%, 480px)", borderRadius: 24 }}>
        <Space direction="vertical" size={18} style={{ width: "100%" }}>
          <Space align="center">
            <span style={{ display: "grid", placeItems: "center", width: 48, height: 48, borderRadius: 16, background: "#ff7f16", color: "white" }}>
              <Smartphone size={25} />
            </span>
            <div>
              <Typography.Title level={3} style={{ margin: 0 }}>LensGo 澳门旅行助手</Typography.Title>
              <Typography.Text type="secondary">连接运行 QwenPaw 与 LensGo 的电脑或服务器</Typography.Text>
            </div>
          </Space>
          <Form<Values>
            layout="vertical"
            initialValues={{
              qwenpawBaseUrl: getApiBaseUrl(),
              lensgoBaseUrl: getLensGoBaseUrl(),
              bridgeToken: getLensGoToken(),
            }}
            onFinish={connect}
          >
            <Form.Item
              name="qwenpawBaseUrl"
              label="QwenPaw 服务地址"
              rules={[{ required: true, message: "请输入 QwenPaw 服务地址" }]}
              extra="例如：http://192.168.1.20:18088；公网部署应使用 HTTPS。"
            >
              <Input prefix={<Server size={16} />} placeholder="http://192.168.1.20:18088" inputMode="url" />
            </Form.Item>
            <Form.Item name="lensgoBaseUrl" label="LensGo Bridge 地址（可稍后配置）">
              <Input prefix={<Server size={16} />} placeholder="http://192.168.1.20:18000" inputMode="url" />
            </Form.Item>
            <Form.Item
              name="bridgeToken"
              label="LensGo Bridge Token（只保留到 App 关闭）"
            >
              <Input.Password prefix={<ShieldCheck size={16} />} autoComplete="off" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              连接并进入 App
            </Button>
          </Form>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            手机仅运行客户端；模型、Agent、眼镜网关和媒体数据仍在你的电脑或服务器上运行。
          </Typography.Text>
        </Space>
      </Card>
    </main>
  );
}
