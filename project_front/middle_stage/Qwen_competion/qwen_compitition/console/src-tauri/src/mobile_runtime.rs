//! Native, local-first runtime used by the Android/iOS LensGo client.
//!
//! The mobile UI never needs a QwenPaw server for its core product features.
//! Provider credentials stay in the app-private data directory and outbound
//! model requests are made here instead of in the WebView.

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const SETTINGS_FILE: &str = "lensgo-mobile-provider.json";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct StoredSettings {
    api_base_url: String,
    api_key: String,
    model: String,
    vision_model: String,
    image_base_url: String,
    image_api_key: String,
    image_model: String,
    system_prompt: String,
    qwenpaw_base_url: String,
    qwenpaw_agent_id: String,
    qwenpaw_auth_token: String,
    crowd_base_url: String,
    crowd_api_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    api_base_url: String,
    api_key: Option<String>,
    model: String,
    vision_model: String,
    image_base_url: String,
    image_api_key: Option<String>,
    image_model: String,
    system_prompt: String,
    qwenpaw_base_url: String,
    qwenpaw_agent_id: String,
    qwenpaw_auth_token: Option<String>,
    clear_api_key: Option<bool>,
    clear_image_api_key: Option<bool>,
    clear_qwenpaw_auth_token: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    api_base_url: String,
    model: String,
    vision_model: String,
    image_base_url: String,
    image_model: String,
    system_prompt: String,
    qwenpaw_base_url: String,
    qwenpaw_agent_id: String,
    has_api_key: bool,
    has_image_api_key: bool,
    has_qwenpaw_auth_token: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrowdSettingsInput {
    base_url: String,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrowdSettingsView {
    base_url: String,
    has_api_key: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    messages: Vec<ChatMessage>,
    model: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    content: String,
    model: String,
    usage: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenPawChatRequest {
    request_id: String,
    text: String,
    session_id: String,
    user_id: String,
    device_id: String,
    context: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotelGatewayRequest {
    operation: String,
    user_id: String,
    bill_id: Option<String>,
    preview_id: Option<String>,
    breakfast: Option<bool>,
    bill_ids: Option<Vec<String>>,
    authorization_id: Option<String>,
    action: Option<String>,
    trip_id: Option<String>,
    expense_id: Option<String>,
    expense: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenPawRouteRequest {
    origin: String,
    destination: String,
    mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatNavigationRequest {
    latitude: f64,
    longitude: f64,
    destination: String,
    mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QwenPawStreamPayload {
    request_id: String,
    event: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPhotoRequest {
    file_name: String,
    data_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPhotoResponse {
    file_id: u64,
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest {
    prompt: String,
    size: Option<String>,
    source_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResponse {
    data_url: String,
    revised_prompt: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysisRequest {
    file_name: String,
    data_url: String,
    captured_at: Option<u64>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImageAnalysisResponse {
    description: String,
    scene: String,
    tags: Vec<String>,
    objects: Vec<String>,
    visible_text: Vec<String>,
    people_summary: Option<String>,
    activity: Option<String>,
    time_of_day: Option<String>,
    search_text: String,
    landmark: Option<String>,
    address: Option<String>,
    district: Option<String>,
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    location_confidence: Option<f64>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join(SETTINGS_FILE))
}

fn load_stored_settings(app: &AppHandle) -> Result<StoredSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(StoredSettings {
            system_prompt: default_system_prompt(),
            qwenpaw_base_url: "http://127.0.0.1:18088".to_string(),
            qwenpaw_agent_id: "lensgo-travel-director".to_string(),
            crowd_base_url: "http://10.9.88.6:18099".to_string(),
            ..StoredSettings::default()
        });
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取本地配置：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("本地配置已损坏：{error}"))
}

fn save_stored_settings(app: &AppHandle, settings: &StoredSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let bytes = serde_json::to_vec(settings).map_err(|error| format!("无法序列化配置：{error}"))?;
    fs::write(&path, bytes).map_err(|error| format!("无法保存本地配置：{error}"))
}

fn default_system_prompt() -> String {
    "你是 LensGo 澳门旅游助手。请用简洁、可靠、友好的中文回答，优先提供澳门旅行、路线、拍照姿势、安全和文化背景建议；涉及实时开放时间、票价或天气时明确提醒用户核实最新信息。"
        .to_string()
}

fn to_view(settings: StoredSettings) -> SettingsView {
    SettingsView {
        api_base_url: settings.api_base_url,
        model: settings.model,
        vision_model: settings.vision_model,
        image_base_url: settings.image_base_url,
        image_model: settings.image_model,
        system_prompt: if settings.system_prompt.trim().is_empty() {
            default_system_prompt()
        } else {
            settings.system_prompt
        },
        qwenpaw_base_url: if settings.qwenpaw_base_url.trim().is_empty() {
            "http://127.0.0.1:18088".to_string()
        } else {
            settings.qwenpaw_base_url
        },
        qwenpaw_agent_id: if settings.qwenpaw_agent_id.trim().is_empty() {
            "lensgo-travel-director".to_string()
        } else {
            settings.qwenpaw_agent_id
        },
        has_api_key: !settings.api_key.trim().is_empty(),
        has_image_api_key: !settings.image_api_key.trim().is_empty(),
        has_qwenpaw_auth_token: !settings.qwenpaw_auth_token.trim().is_empty(),
    }
}

fn crowd_settings_view(settings: &StoredSettings) -> CrowdSettingsView {
    CrowdSettingsView {
        base_url: if settings.crowd_base_url.trim().is_empty() {
            "http://10.9.88.6:18099".to_string()
        } else {
            settings
                .crowd_base_url
                .trim()
                .trim_end_matches('/')
                .to_string()
        },
        has_api_key: !settings.crowd_api_key.trim().is_empty(),
    }
}

fn normalize_endpoint(base: &str, suffix: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || cfg!(debug_assertions) && base.starts_with("http://")) {
        return Err("API 地址必须使用 HTTPS（调试构建允许 HTTP）".to_string());
    }
    if base.ends_with(suffix) {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}{suffix}"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageApiProvider {
    OpenAi,
    Alibaba,
}

fn image_api_provider(base: &str, model: &str) -> ImageApiProvider {
    let host = reqwest::Url::parse(base.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    let alibaba_host = host == "dashscope.aliyuncs.com"
        || host.contains("dashscope") && host.ends_with(".aliyuncs.com")
        || host.ends_with(".maas.aliyuncs.com");
    if alibaba_host && model.trim().to_ascii_lowercase().starts_with("qwen-image") {
        ImageApiProvider::Alibaba
    } else {
        ImageApiProvider::OpenAi
    }
}

fn alibaba_image_endpoint(base: &str) -> Result<String, String> {
    const PATH: &str = "/api/v1/services/aigc/multimodal-generation/generation";
    let mut url =
        reqwest::Url::parse(base.trim()).map_err(|error| format!("图片 API 地址无效：{error}"))?;
    if url.scheme() != "https" && !(cfg!(debug_assertions) && url.scheme() == "http") {
        return Err("API 地址必须使用 HTTPS（调试构建允许 HTTP）".to_string());
    }
    url.set_path(PATH);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn alibaba_image_size(size: &str) -> String {
    size.replace('x', "*").replace('X', "*")
}

fn alibaba_image_url(value: &Value) -> Option<&str> {
    value
        .pointer("/output/choices")?
        .as_array()?
        .iter()
        .filter_map(|choice| choice.pointer("/message/content").and_then(Value::as_array))
        .flatten()
        .find_map(|item| {
            item.get("image")
                .or_else(|| item.get("url"))
                .and_then(Value::as_str)
                .filter(|url| !url.trim().is_empty())
        })
}

fn private_http_base(base: &str) -> bool {
    let authority = match base.strip_prefix("http://") {
        Some(value) => value.split('/').next().unwrap_or_default(),
        None => return false,
    };
    let host = authority
        .trim_start_matches('[')
        .split(']')
        .next()
        .unwrap_or(authority)
        .split(':')
        .next()
        .unwrap_or_default();
    if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    if host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(part) = rest
            .split('.')
            .next()
            .and_then(|value| value.parse::<u8>().ok())
        {
            return (16..=31).contains(&part);
        }
    }
    false
}

fn crowd_endpoint(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写人流服务地址".to_string());
    }
    if !(base.starts_with("https://")
        || private_http_base(base)
        || cfg!(debug_assertions) && base.starts_with("http://"))
    {
        return Err("人流服务公网地址必须使用 HTTPS；HTTP 仅允许本机或局域网地址".to_string());
    }
    Ok(format!(
        "{base}/api/density/latest?city_id=macau&level=poi&include_empty=1"
    ))
}

fn qwenpaw_endpoint(settings: &StoredSettings, suffix: &str) -> Result<String, String> {
    let base = settings.qwenpaw_base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先在设置中填写 QwenPaw 服务地址".to_string());
    }
    if !(base.starts_with("https://")
        || private_http_base(base)
        || cfg!(debug_assertions) && base.starts_with("http://"))
    {
        return Err("QwenPaw 公网地址必须使用 HTTPS；HTTP 仅允许本机或局域网地址".to_string());
    }
    Ok(format!("{base}{suffix}"))
}

fn qwenpaw_request(
    client: &reqwest::Client,
    settings: &StoredSettings,
    method: reqwest::Method,
    endpoint: String,
) -> reqwest::RequestBuilder {
    let mut request = client
        .request(method, endpoint)
        .header("X-Agent-Id", settings.qwenpaw_agent_id.trim());
    if !settings.qwenpaw_auth_token.trim().is_empty() {
        request = request.bearer_auth(settings.qwenpaw_auth_token.trim());
    }
    request
}

async fn parse_error(response: reqwest::Response) -> String {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if let Some(message) = value
            .pointer("/error/message")
            .or_else(|| value.get("message"))
            .or_else(|| value.get("detail"))
            .and_then(Value::as_str)
        {
            return format!("模型服务返回 HTTP {status}：{message}");
        }
    }
    let compact = text.chars().take(240).collect::<String>();
    if compact.is_empty() {
        format!("模型服务返回 HTTP {status}")
    } else {
        format!("模型服务返回 HTTP {status}：{compact}")
    }
}

fn extract_message_content(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

async fn perform_chat(
    settings: &StoredSettings,
    mut messages: Vec<ChatMessage>,
    requested_model: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u64>,
) -> Result<ChatResponse, String> {
    if settings.api_key.trim().is_empty() {
        return Err("请先在“设置”中填写模型 API Key".to_string());
    }
    let model = requested_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| settings.model.trim());
    if model.is_empty() {
        return Err("请先在“设置”中填写模型名称".to_string());
    }
    let endpoint = normalize_endpoint(&settings.api_base_url, "/chat/completions")?;
    if !settings.system_prompt.trim().is_empty()
        && !messages.iter().any(|message| message.role == "system")
    {
        messages.insert(
            0,
            ChatMessage {
                role: "system".to_string(),
                content: settings.system_prompt.clone(),
            },
        );
    }
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "temperature": temperature.unwrap_or(0.6)
    });
    if let Some(value) = max_tokens {
        body["max_tokens"] = json!(value);
    }
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("无法连接模型服务：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("模型响应不是有效 JSON：{error}"))?;
    let content =
        extract_message_content(&value).ok_or_else(|| "模型响应中没有可显示的文字".to_string())?;
    Ok(ChatResponse {
        content,
        model: value
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or(model)
            .to_string(),
        usage: value.get("usage").cloned(),
    })
}

#[tauri::command]
pub fn mobile_load_settings(app: AppHandle) -> Result<SettingsView, String> {
    load_stored_settings(&app).map(to_view)
}

#[tauri::command]
pub fn mobile_save_settings(
    app: AppHandle,
    settings: SettingsInput,
) -> Result<SettingsView, String> {
    let mut stored = load_stored_settings(&app)?;
    stored.api_base_url = settings
        .api_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    stored.model = settings.model.trim().to_string();
    stored.vision_model = settings.vision_model.trim().to_string();
    stored.image_base_url = settings
        .image_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    stored.image_model = settings.image_model.trim().to_string();
    stored.system_prompt = if settings.system_prompt.trim().is_empty() {
        default_system_prompt()
    } else {
        settings.system_prompt.trim().to_string()
    };
    stored.qwenpaw_base_url = settings
        .qwenpaw_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    stored.qwenpaw_agent_id = settings.qwenpaw_agent_id.trim().to_string();
    if settings.clear_api_key.unwrap_or(false) {
        stored.api_key.clear();
    } else if let Some(key) = settings.api_key.filter(|value| !value.trim().is_empty()) {
        stored.api_key = key.trim().to_string();
    }
    if settings.clear_image_api_key.unwrap_or(false) {
        stored.image_api_key.clear();
    } else if let Some(key) = settings
        .image_api_key
        .filter(|value| !value.trim().is_empty())
    {
        stored.image_api_key = key.trim().to_string();
    }
    if settings.clear_qwenpaw_auth_token.unwrap_or(false) {
        stored.qwenpaw_auth_token.clear();
    } else if let Some(token) = settings
        .qwenpaw_auth_token
        .filter(|value| !value.trim().is_empty())
    {
        stored.qwenpaw_auth_token = token.trim().to_string();
    }
    save_stored_settings(&app, &stored)?;
    Ok(to_view(stored))
}

#[tauri::command]
pub fn mobile_load_crowd_settings(app: AppHandle) -> Result<CrowdSettingsView, String> {
    let stored = load_stored_settings(&app)?;
    Ok(crowd_settings_view(&stored))
}

#[tauri::command]
pub fn mobile_save_crowd_settings(
    app: AppHandle,
    settings: CrowdSettingsInput,
) -> Result<CrowdSettingsView, String> {
    let mut stored = load_stored_settings(&app)?;
    let base_url = settings.base_url.trim().trim_end_matches('/');
    // Validate before persisting so a malformed or insecure public URL cannot
    // silently replace the last working endpoint.
    crowd_endpoint(base_url)?;
    stored.crowd_base_url = base_url.to_string();
    if settings.clear_api_key.unwrap_or(false) {
        stored.crowd_api_key.clear();
    } else if let Some(api_key) = settings.api_key.filter(|value| !value.trim().is_empty()) {
        stored.crowd_api_key = api_key.trim().to_string();
    }
    save_stored_settings(&app, &stored)?;
    Ok(crowd_settings_view(&stored))
}

#[tauri::command]
pub async fn mobile_fetch_crowd_places(app: AppHandle) -> Result<Value, String> {
    let stored = load_stored_settings(&app)?;
    if stored.crowd_api_key.trim().is_empty() {
        return Err("请先在设置中填写本设备的人流 API Key".to_string());
    }
    let endpoint = crowd_endpoint(&stored.crowd_base_url)?;
    // This is deliberately the read-only density endpoint. Mobile crowd
    // checks never call map-provider endpoints, avoiding any external quota use.
    let response = reqwest::Client::new()
        .get(endpoint)
        .header("Accept", "application/json")
        .bearer_auth(stored.crowd_api_key.trim())
        .send()
        .await
        .map_err(|error| format!("无法连接人流服务：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("无法读取人流服务响应：{error}"))?;
    if !status.is_success() {
        let detail = text.chars().take(240).collect::<String>();
        return Err(if detail.is_empty() {
            format!("人流服务返回 HTTP {status}")
        } else {
            format!("人流服务返回 HTTP {status}：{detail}")
        });
    }
    let payload: Value = serde_json::from_str(&text)
        .map_err(|error| format!("人流服务返回的不是有效 JSON：{error}"))?;
    if payload.get("items").and_then(Value::as_array).is_none() {
        return Err("人流服务返回格式不正确".to_string());
    }
    Ok(payload)
}

#[tauri::command]
pub async fn mobile_test_provider(app: AppHandle) -> Result<ChatResponse, String> {
    let settings = load_stored_settings(&app)?;
    perform_chat(
        &settings,
        vec![ChatMessage {
            role: "user".to_string(),
            content: "请只回复：LensGo 连接成功".to_string(),
        }],
        None,
        Some(0.0),
        Some(32),
    )
    .await
}

#[tauri::command]
pub async fn mobile_chat(app: AppHandle, request: ChatRequest) -> Result<ChatResponse, String> {
    let settings = load_stored_settings(&app)?;
    perform_chat(
        &settings,
        request.messages,
        request.model,
        request.temperature,
        request.max_tokens,
    )
    .await
}

#[tauri::command]
pub async fn mobile_list_models(app: AppHandle) -> Result<Vec<String>, String> {
    let settings = load_stored_settings(&app)?;
    if settings.api_key.trim().is_empty() {
        return Err("请先在“设置”中填写模型 API Key".to_string());
    }
    let endpoint = normalize_endpoint(&settings.api_base_url, "/models")?;
    let response = reqwest::Client::new()
        .get(endpoint)
        .bearer_auth(settings.api_key.trim())
        .send()
        .await
        .map_err(|error| format!("无法读取模型列表：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("模型列表不是有效 JSON：{error}"))?;
    let candidates = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for candidate in candidates {
        let id = candidate
            .get("id")
            .or_else(|| candidate.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if !id.is_empty() && !models.iter().any(|item| item == id) {
            models.push(id.to_string());
        }
        if models.len() >= 100 {
            break;
        }
    }
    let configured = settings.model.trim();
    if !configured.is_empty() && !models.iter().any(|item| item == configured) {
        models.insert(0, configured.to_string());
    }
    Ok(models)
}

#[tauri::command]
pub async fn mobile_test_qwenpaw(app: AppHandle) -> Result<String, String> {
    let settings = load_stored_settings(&app)?;
    if settings.qwenpaw_agent_id.trim().is_empty() {
        return Err("请先填写 QwenPaw Agent ID".to_string());
    }
    let endpoint = qwenpaw_endpoint(&settings, "/api/agents")?;
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::GET, endpoint)
        .send()
        .await
        .map_err(|error| format!("无法连接 QwenPaw：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("QwenPaw 返回格式无效：{error}"))?;
    let exists = payload
        .get("agents")
        .and_then(Value::as_array)
        .map(|agents| {
            agents.iter().any(|agent| {
                agent.get("id").and_then(Value::as_str) == Some(settings.qwenpaw_agent_id.trim())
            })
        })
        .unwrap_or(true);
    if !exists {
        return Err(format!(
            "QwenPaw 已连接，但没有找到 Agent：{}",
            settings.qwenpaw_agent_id
        ));
    }
    Ok(format!(
        "QwenPaw 已连接，当前主 Agent：{}",
        settings.qwenpaw_agent_id
    ))
}

fn emit_qwenpaw_event(app: &AppHandle, request_id: &str, event: Value) -> Result<(), String> {
    app.emit(
        "lensgo-qwenpaw-event",
        QwenPawStreamPayload {
            request_id: request_id.to_string(),
            event,
        },
    )
    .map_err(|error| format!("无法向聊天界面发送流式事件：{error}"))
}

fn parse_sse_line(app: &AppHandle, request_id: &str, line: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(line)
        .map_err(|error| format!("QwenPaw 流包含无效 UTF-8：{error}"))?
        .trim_end_matches('\r');
    let Some(payload) = text.strip_prefix("data:") else {
        return Ok(());
    };
    let payload = payload.trim_start();
    if payload.is_empty() || payload == "[DONE]" {
        return Ok(());
    }
    let event: Value = serde_json::from_str(payload)
        .map_err(|error| format!("QwenPaw 流事件不是有效 JSON：{error}"))?;
    emit_qwenpaw_event(app, request_id, event)
}

#[tauri::command]
pub async fn mobile_qwenpaw_chat(
    app: AppHandle,
    request: QwenPawChatRequest,
) -> Result<(), String> {
    let settings = load_stored_settings(&app)?;
    if settings.qwenpaw_agent_id.trim().is_empty() {
        return Err("请先在设置中填写 QwenPaw Agent ID".to_string());
    }
    let endpoint = qwenpaw_endpoint(&settings, "/api/console/chat")?;
    let context = request.context.unwrap_or_default();
    let text = if context.trim().is_empty() {
        request.text
    } else {
        format!(
            "<lensgo_mobile_context device_id=\"{}\">\n{}\n</lensgo_mobile_context>\n\n用户消息：{}",
            request.device_id, context, request.text
        )
    };
    let body = json!({
        "input": [{
            "role": "user",
            "content": [{"type": "text", "text": text}]
        }],
        "session_id": request.session_id,
        "chat_id": request.session_id,
        "user_id": request.user_id,
        "channel": "lensgo-mobile"
    });
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::POST, endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("无法连接 QwenPaw：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("QwenPaw 流式响应中断：{error}"))?;
        buffer.extend_from_slice(&chunk);
        while let Some(index) = buffer.iter().position(|value| *value == b'\n') {
            let mut line = buffer.drain(..=index).collect::<Vec<_>>();
            line.pop();
            parse_sse_line(&app, &request.request_id, &line)?;
        }
    }
    if !buffer.is_empty() {
        parse_sse_line(&app, &request.request_id, &buffer)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_qwenpaw_latest_itinerary(app: AppHandle) -> Result<Option<Value>, String> {
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(&settings, "/api/travel-planner/latest")?;
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::GET, endpoint)
        .send()
        .await
        .map_err(|error| format!("无法读取 QwenPaw 行程：{error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    response
        .json::<Value>()
        .await
        .map(Some)
        .map_err(|error| format!("QwenPaw 行程数据格式无效：{error}"))
}

#[tauri::command]
pub async fn mobile_trip_guide_nearby(
    app: AppHandle,
    latitude: f64,
    longitude: f64,
    kind: String,
) -> Result<Value, String> {
    if !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
        || !matches!(kind.as_str(), "food" | "photo")
    {
        return Err("附近导览查询参数无效".to_string());
    }
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(&settings, "/api/travel-planner/guide/nearby")?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|_| "无法初始化附近导览连接".to_string())?;
    let response = qwenpaw_request(&client, &settings, reqwest::Method::POST, endpoint)
        .json(&json!({ "latitude": latitude, "longitude": longitude, "kind": kind }))
        .send()
        .await
        .map_err(|_| "附近地点服务连接失败，请稍后重试".to_string())?;
    if !response.status().is_success() {
        return Err("附近地点服务暂不可用，请稍后重试".to_string());
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "附近地点返回格式无效".to_string())
}

#[tauri::command]
pub async fn mobile_trip_guide_origin(
    app: AppHandle,
    latitude: f64,
    longitude: f64,
) -> Result<Value, String> {
    if !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
    {
        return Err("出发地查询参数无效".to_string());
    }
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(&settings, "/api/travel-planner/guide/origin")?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化出发地连接".to_string())?;
    let response = qwenpaw_request(&client, &settings, reqwest::Method::POST, endpoint)
        .json(&json!({ "latitude": latitude, "longitude": longitude }))
        .send()
        .await
        .map_err(|_| "出发地服务暂不可用".to_string())?;
    if !response.status().is_success() {
        return Err("出发地服务暂不可用".to_string());
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "出发地返回格式无效".to_string())
}

#[tauri::command]
pub async fn mobile_hotel_gateway(
    app: AppHandle,
    request: HotelGatewayRequest,
) -> Result<Value, String> {
    let settings = load_stored_settings(&app)?;
    let safe_id = |value: &str| {
        !value.is_empty()
            && value.len() <= 96
            && value
                .bytes()
                .all(|item| item.is_ascii_alphanumeric() || item == b'_' || item == b'-')
    };
    if !safe_id(request.user_id.trim()) {
        return Err("手机用户标识无效".to_string());
    }

    let bill_id = request.bill_id.as_deref().unwrap_or("");
    let trip_id = request.trip_id.as_deref().unwrap_or("");
    let expense_id = request.expense_id.as_deref().unwrap_or("");
    let (method, path, body) = match request.operation.as_str() {
        "list_bills" | "list_authorizations" => (
            reqwest::Method::GET,
            "/api/travel-planner/hotel/state".to_string(),
            None,
        ),
        "preview_adjustment" if safe_id(bill_id) => (
            reqwest::Method::POST,
            format!("/api/travel-planner/hotel/bills/{bill_id}/adjustments/preview"),
            Some(json!({"breakfast": request.breakfast.unwrap_or(false)})),
        ),
        "confirm_adjustment" if safe_id(bill_id) => {
            let preview_id = request.preview_id.as_deref().unwrap_or("");
            if !safe_id(preview_id) {
                return Err("账单调整预览编号无效".to_string());
            }
            (
                reqwest::Method::POST,
                format!("/api/travel-planner/hotel/bills/{bill_id}/adjustments/confirm"),
                Some(json!({"preview_id": preview_id})),
            )
        }
        "update_authorization" => {
            let action = request.action.as_deref().unwrap_or("");
            let authorization_id = request.authorization_id.as_deref().unwrap_or("");
            if !matches!(action, "grant" | "revoke") || !safe_id(authorization_id) {
                return Err("付款授权操作无效".to_string());
            }
            (
                reqwest::Method::POST,
                "/api/travel-planner/hotel/payment-authorizations".to_string(),
                Some(json!({
                    "action": action,
                    "authorization_id": authorization_id
                })),
            )
        }
        "pay" => {
            let bill_ids = request.bill_ids.unwrap_or_default();
            if bill_ids.is_empty() || bill_ids.iter().any(|item| !safe_id(item)) {
                return Err("请选择有效的待支付账单".to_string());
            }
            (
                reqwest::Method::POST,
                "/api/travel-planner/hotel/payments".to_string(),
                Some(json!({"bill_ids": bill_ids})),
            )
        }
        "list_trip_expenses" if safe_id(trip_id) => (
            reqwest::Method::GET,
            format!("/api/travel-planner/trip-expenses?trip_id={trip_id}"),
            None,
        ),
        "create_trip_expense" if safe_id(trip_id) => {
            let mut payload = request.expense.unwrap_or_else(|| json!({}));
            let Some(object) = payload.as_object_mut() else {
                return Err("费用内容格式无效".to_string());
            };
            object.insert("trip_id".to_string(), json!(trip_id));
            (
                reqwest::Method::POST,
                "/api/travel-planner/trip-expenses".to_string(),
                Some(payload),
            )
        }
        "update_trip_expense" if safe_id(expense_id) => {
            let payload = request.expense.unwrap_or_else(|| json!({}));
            if !payload.is_object() {
                return Err("费用内容格式无效".to_string());
            }
            (
                reqwest::Method::PATCH,
                format!("/api/travel-planner/trip-expenses/{expense_id}"),
                Some(payload),
            )
        }
        "delete_trip_expense" if safe_id(expense_id) => (
            reqwest::Method::DELETE,
            format!("/api/travel-planner/trip-expenses/{expense_id}"),
            None,
        ),
        "delete_trip_expenses" if safe_id(trip_id) => (
            reqwest::Method::DELETE,
            format!("/api/travel-planner/trip-expenses?trip_id={trip_id}"),
            None,
        ),
        _ => return Err("不支持的账单操作".to_string()),
    };

    let endpoint = qwenpaw_endpoint(&settings, &path)?;
    let client = reqwest::Client::new();
    let mut builder = qwenpaw_request(&client, &settings, method, endpoint);
    if let Some(payload) = body {
        builder = builder.json(&payload);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("无法连接账单网关：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("账单网关返回格式无效：{error}"))
}

#[tauri::command]
pub async fn mobile_qwenpaw_route(
    app: AppHandle,
    request: QwenPawRouteRequest,
) -> Result<Value, String> {
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(&settings, "/api/travel-planner/route")?;
    let mode = if request.mode.as_deref() == Some("walking") {
        "walking"
    } else {
        "driving"
    };
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::GET, endpoint)
        .query(&[
            ("origin", request.origin.as_str()),
            ("destination", request.destination.as_str()),
            ("mode", mode),
        ])
        .send()
        .await
        .map_err(|error| format!("无法读取服务器高德路线：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("服务器高德路线格式无效：{error}"))
}

#[tauri::command]
pub async fn mobile_chat_navigation(
    app: AppHandle,
    request: ChatNavigationRequest,
) -> Result<Value, String> {
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(&settings, "/api/travel-planner/navigation")?;
    let mode = match request.mode.as_deref() {
        Some("walking") => "walking",
        Some("driving") => "driving",
        _ => "transit",
    };
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::POST, endpoint)
        .json(&json!({
            "latitude": request.latitude,
            "longitude": request.longitude,
            "destination": request.destination,
            "mode": mode,
        }))
        .send()
        .await
        .map_err(|error| format!("无法连接对话导航服务：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("对话导航返回格式无效：{error}"))
}

fn decode_image_data_url(value: &str) -> Result<(String, Vec<u8>), String> {
    let (header, payload) = value
        .split_once(',')
        .ok_or_else(|| "照片 data URL 格式无效".to_string())?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("只能同步 base64 图片".to_string());
    }
    let media_type = header
        .trim_start_matches("data:")
        .trim_end_matches(";base64")
        .to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("无法解码照片：{error}"))?;
    if bytes.is_empty() {
        return Err("不能同步空照片".to_string());
    }
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("单张云端同步照片不能超过 20 MB".to_string());
    }
    Ok((media_type, bytes))
}

#[tauri::command]
pub async fn mobile_upload_cloud_photo(
    app: AppHandle,
    request: CloudPhotoRequest,
) -> Result<CloudPhotoResponse, String> {
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(&settings, "/api/travel-planner/album/photos")?;
    let (media_type, bytes) = decode_image_data_url(&request.data_url)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(request.file_name)
        .mime_str(&media_type)
        .map_err(|error| format!("照片类型无效：{error}"))?;
    let form = reqwest::multipart::Form::new().part("photo", part);
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::POST, endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("无法上传照片到 QwenPaw：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("云端相册返回格式无效：{error}"))?;
    let file_id = payload
        .get("file_id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "云端相册没有返回照片 ID".to_string())?;
    Ok(CloudPhotoResponse {
        file_id,
        message: payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("照片已同步到云端")
            .to_string(),
    })
}

#[tauri::command]
pub async fn mobile_delete_cloud_photo(app: AppHandle, file_id: u64) -> Result<(), String> {
    let settings = load_stored_settings(&app)?;
    let endpoint = qwenpaw_endpoint(
        &settings,
        &format!("/api/travel-planner/album/photos/{file_id}"),
    )?;
    let client = reqwest::Client::new();
    let response = qwenpaw_request(&client, &settings, reqwest::Method::DELETE, endpoint)
        .send()
        .await
        .map_err(|error| format!("无法删除云端照片：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    Ok(())
}

fn extract_json_object(text: &str) -> Result<&str, String> {
    let start = text
        .find('{')
        .ok_or_else(|| "识图模型没有返回 JSON 对象".to_string())?;
    let end = text
        .rfind('}')
        .ok_or_else(|| "识图模型返回的 JSON 不完整".to_string())?;
    if end <= start {
        return Err("识图模型返回的 JSON 不完整".to_string());
    }
    Ok(&text[start..=end])
}

fn normalize_analysis(mut analysis: ImageAnalysisResponse) -> ImageAnalysisResponse {
    fn clean(value: &str, limit: usize) -> String {
        value.trim().chars().take(limit).collect()
    }
    fn clean_optional(value: Option<String>, limit: usize) -> Option<String> {
        value
            .map(|item| clean(&item, limit))
            .filter(|item| !item.is_empty())
    }
    fn clean_list(values: Vec<String>) -> Vec<String> {
        values
            .into_iter()
            .map(|value| clean(&value, 48))
            .filter(|value| !value.is_empty())
            .take(24)
            .collect()
    }
    analysis.description = clean(&analysis.description, 800);
    analysis.scene = clean(&analysis.scene, 120);
    analysis.search_text = clean(&analysis.search_text, 1200);
    analysis.tags = clean_list(analysis.tags);
    analysis.objects = clean_list(analysis.objects);
    analysis.visible_text = clean_list(analysis.visible_text);
    analysis.people_summary = clean_optional(analysis.people_summary, 180);
    analysis.activity = clean_optional(analysis.activity, 120);
    analysis.time_of_day = clean_optional(analysis.time_of_day, 60);
    analysis.landmark = clean_optional(analysis.landmark, 160);
    analysis.address = clean_optional(analysis.address, 240);
    analysis.district = clean_optional(analysis.district, 120);
    analysis.city = clean_optional(analysis.city, 120);
    analysis.region = clean_optional(analysis.region, 120);
    analysis.country = clean_optional(analysis.country, 120);
    analysis.location_confidence = analysis
        .location_confidence
        .map(|value| value.clamp(0.0, 1.0));
    if !analysis
        .latitude
        .is_some_and(|value| (-90.0..=90.0).contains(&value))
    {
        analysis.latitude = None;
    }
    if !analysis
        .longitude
        .is_some_and(|value| (-180.0..=180.0).contains(&value))
    {
        analysis.longitude = None;
    }
    analysis
}

#[tauri::command]
pub async fn mobile_analyze_image(
    app: AppHandle,
    request: ImageAnalysisRequest,
) -> Result<ImageAnalysisResponse, String> {
    let settings = load_stored_settings(&app)?;
    if settings.api_key.trim().is_empty() {
        return Err("请先在“设置”中填写模型 API Key".to_string());
    }
    let model = if settings.vision_model.trim().is_empty() {
        settings.model.trim()
    } else {
        settings.vision_model.trim()
    };
    if model.is_empty() {
        return Err("请先在“设置”中填写识图模型名称".to_string());
    }
    if !request.data_url.starts_with("data:image/") {
        return Err("识图输入必须是图片 data URL".to_string());
    }
    if request.data_url.len() > 28 * 1024 * 1024 {
        return Err("识图图片超过 20 MB 安全上限".to_string());
    }
    let endpoint = normalize_endpoint(&settings.api_base_url, "/chat/completions")?;
    let metadata = match (request.latitude, request.longitude) {
        (Some(latitude), Some(longitude)) => format!(
            "文件名：{}；拍摄时间戳：{:?}；照片 EXIF GPS：{latitude:.7},{longitude:.7}。EXIF GPS 优先于画面推测。",
            request.file_name, request.captured_at
        ),
        _ => format!(
            "文件名：{}；拍摄时间戳：{:?}；照片没有可用 EXIF GPS。",
            request.file_name, request.captured_at
        ),
    };
    let prompt = format!(
        r#"你是私人旅行相册的视觉索引器。分析图片并只返回一个 JSON 对象，不要 Markdown。
{metadata}
JSON 字段必须为：
{{
  "description":"客观、可检索的中文画面描述",
  "scene":"场景类别",
  "tags":["地点、建筑、食物、天气、颜色、事件等短标签"],
  "objects":["主要物体"],
  "visibleText":["能可靠读出的画面文字"],
  "peopleSummary":"不识别身份，只描述人数、穿着和姿态",
  "activity":"画面活动",
  "timeOfDay":"白天/夜晚/黄昏等",
  "searchText":"把地点、商户、内容、文字和同义表达合并成自然中文检索文本",
  "landmark":"只有高度确定时填写地标或商户名，否则 null",
  "address":"可从可靠 GPS 或清晰路牌判断时填写，否则 null",
  "district":"行政区或片区，否则 null",
  "city":"城市，否则 null",
  "region":"省级地区，否则 null",
  "country":"国家或地区，否则 null",
  "latitude":只有画面明确识别出著名地标且位置置信度>=0.75时才给近似纬度，否则 null,
  "longitude":同上,
  "locationConfidence":0到1
}}
禁止猜测人名、敏感属性或不确定地址。地点不确定时保留 null。"#,
    );
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": request.data_url, "detail": "low"}}
            ]
        }],
        "stream": false,
        "temperature": 0.1,
        "max_tokens": 1200
    });
    let response = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("无法连接识图模型：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("识图响应不是有效 JSON：{error}"))?;
    let content =
        extract_message_content(&value).ok_or_else(|| "识图模型响应中没有内容".to_string())?;
    let json_text = extract_json_object(&content)?;
    let analysis = serde_json::from_str::<ImageAnalysisResponse>(json_text)
        .map_err(|error| format!("无法解析识图标注：{error}"))?;
    Ok(normalize_analysis(analysis))
}

#[tauri::command]
pub async fn mobile_generate_image(
    app: AppHandle,
    request: ImageRequest,
) -> Result<ImageResponse, String> {
    let settings = load_stored_settings(&app)?;
    let base = if settings.image_base_url.trim().is_empty() {
        &settings.api_base_url
    } else {
        &settings.image_base_url
    };
    let key = if settings.image_api_key.trim().is_empty() {
        &settings.api_key
    } else {
        &settings.image_api_key
    };
    if key.trim().is_empty() {
        return Err("请先在“设置”中填写图片 API Key".to_string());
    }
    if settings.image_model.trim().is_empty() {
        return Err("请先在“设置”中填写图片模型名称".to_string());
    }
    let model = settings.image_model.trim();
    let source_data_url = request
        .source_data_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(source) = source_data_url {
        if !source.starts_with("data:image/") {
            return Err("现场参考图必须是图片 data URL".to_string());
        }
        if source.len() > 28 * 1024 * 1024 {
            return Err("现场参考图超过 20 MB 安全上限".to_string());
        }
    }
    let size = request.size.unwrap_or_else(|| "1024x1024".to_string());
    let provider = image_api_provider(base, model);
    let client = reqwest::Client::new();
    let image_request = match provider {
        ImageApiProvider::Alibaba => {
            let mut content = Vec::new();
            if let Some(source) = source_data_url {
                content.push(json!({"image": source}));
            }
            content.push(json!({"text": request.prompt}));
            client
                .post(alibaba_image_endpoint(base)?)
                .bearer_auth(key.trim())
                .json(&json!({
                    "model": model,
                    "input": {
                        "messages": [{
                            "role": "user",
                            "content": content
                        }]
                    },
                    "parameters": {
                        "n": 1,
                        "size": alibaba_image_size(&size)
                    }
                }))
        }
        ImageApiProvider::OpenAi => {
            let endpoint_suffix = if source_data_url.is_some() {
                "/images/edits"
            } else {
                "/images/generations"
            };
            let endpoint = normalize_endpoint(base, endpoint_suffix)?;
            if let Some(source) = source_data_url {
                if model.to_ascii_lowercase().starts_with("dall-e-3") {
                    return Err("DALL·E 3 不支持现场图编辑，请改用 GPT Image 模型".to_string());
                }
                let (media_type, bytes) = decode_image_data_url(source)?;
                let extension = match media_type.as_str() {
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    _ => "png",
                };
                let part = reqwest::multipart::Part::bytes(bytes)
                    .file_name(format!("lensgo-source.{extension}"))
                    .mime_str(&media_type)
                    .map_err(|error| format!("现场参考图格式无效：{error}"))?;
                let mut form = reqwest::multipart::Form::new()
                    .text("model", model.to_string())
                    .text("prompt", request.prompt)
                    .text("n", "1")
                    .text("size", size)
                    .part("image", part);
                if !model.to_ascii_lowercase().starts_with("gpt-image") {
                    form = form.text("response_format", "b64_json");
                }
                client
                    .post(endpoint)
                    .bearer_auth(key.trim())
                    .multipart(form)
            } else {
                let mut body = json!({
                    "model": model,
                    "prompt": request.prompt,
                    "n": 1,
                    "size": size
                });
                if !model.to_ascii_lowercase().starts_with("gpt-image") {
                    body["response_format"] = Value::String("b64_json".to_string());
                }
                client.post(endpoint).bearer_auth(key.trim()).json(&body)
            }
        }
    };
    let response = image_request
        .send()
        .await
        .map_err(|error| format!("无法连接图片服务：{error}"))?;
    if !response.status().is_success() {
        return Err(parse_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("图片响应不是有效 JSON：{error}"))?;
    let (url, revised_prompt) = match provider {
        ImageApiProvider::Alibaba => (
            alibaba_image_url(&value)
                .ok_or_else(|| "阿里云图片响应中没有 image URL".to_string())?,
            None,
        ),
        ImageApiProvider::OpenAi => {
            let first = value
                .pointer("/data/0")
                .ok_or_else(|| "图片服务没有返回图片".to_string())?;
            let revised_prompt = first
                .get("revised_prompt")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(encoded) = first.get("b64_json").and_then(Value::as_str) {
                return Ok(ImageResponse {
                    data_url: format!("data:image/png;base64,{encoded}"),
                    revised_prompt,
                });
            }
            (
                first
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "图片响应缺少 b64_json 或 url".to_string())?,
                revised_prompt,
            )
        }
    };
    let image_response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("无法下载生成图片：{error}"))?;
    if !image_response.status().is_success() {
        return Err(parse_error(image_response).await);
    }
    let mime = image_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = image_response
        .bytes()
        .await
        .map_err(|error| format!("无法读取生成图片：{error}"))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("生成图片超过 20 MB 安全上限".to_string());
    }
    Ok(ImageResponse {
        data_url: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        revised_prompt,
    })
}
