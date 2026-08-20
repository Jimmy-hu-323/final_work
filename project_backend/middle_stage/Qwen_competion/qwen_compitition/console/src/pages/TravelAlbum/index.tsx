import { Button, Empty, Modal, Popconfirm, Spin, Tag } from "antd";
import {
  CalendarDays,
  Camera,
  Image,
  MapPin,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApiToken, getApiUrl } from "../../api/config";
import { buildAuthHeaders } from "../../api/authHeaders";
import styles from "./index.module.less";

interface AlbumPhoto {
  file_id: number;
  filename: string;
  display_name: string;
  content_type?: string | null;
  created_at: string;
  taken_at?: string | null;
  gps_lat?: number | null;
  gps_lon?: number | null;
  camera_make?: string | null;
  camera_model?: string | null;
  width?: number | null;
  height?: number | null;
  summary?: string | null;
  tags?: string[];
}

interface AlbumResponse {
  items: AlbumPhoto[];
  total: number;
}

function photoTime(photo: AlbumPhoto) {
  return photo.taken_at || photo.created_at;
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function imageUrl(fileId: number) {
  const url = getApiUrl(`/travel-planner/album/photos/${fileId}/image`);
  const token = getApiToken();
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

export default function TravelAlbum() {
  const [photos, setPhotos] = useState<AlbumPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [selectedPhoto, setSelectedPhoto] = useState<AlbumPhoto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const loadPhotos = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(
        getApiUrl("/travel-planner/album/photos?limit=120&offset=0"),
        { headers: buildAuthHeaders(), cache: "no-store" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail || "暂时无法读取 AI Drive 相册。");
      }
      const payload = (await response.json()) as AlbumResponse;
      const ordered = [...(payload.items || [])].sort(
        (first, second) =>
          new Date(photoTime(second)).getTime() -
          new Date(photoTime(first)).getTime(),
      );
      setPhotos(ordered);
      setTotal(payload.total || ordered.length);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "暂时无法读取 AI Drive 相册。",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setActionError("");
    try {
      for (const photo of Array.from(files)) {
        if (!photo.type.startsWith("image/")) {
          throw new Error(`「${photo.name}」不是图片文件。`);
        }
        const formData = new FormData();
        formData.append("photo", photo);
        const response = await fetch(getApiUrl("/travel-planner/album/photos"), {
          method: "POST",
          headers: buildAuthHeaders(),
          body: formData,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail || `「${photo.name}」上传失败。`);
        }
      }
      await loadPhotos(true);
    } catch (uploadError) {
      setActionError(
        uploadError instanceof Error ? uploadError.message : "图片上传失败。",
      );
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const deletePhoto = async () => {
    if (!selectedPhoto) return;
    setDeleting(true);
    setActionError("");
    try {
      const response = await fetch(
        getApiUrl(`/travel-planner/album/photos/${selectedPhoto.file_id}`),
        { method: "DELETE", headers: buildAuthHeaders() },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail || "删除图片失败。");
      }
      setSelectedPhoto(null);
      await loadPhotos(true);
    } catch (deleteError) {
      setActionError(
        deleteError instanceof Error ? deleteError.message : "删除图片失败。",
      );
    } finally {
      setDeleting(false);
    }
  };

  const groups = useMemo(() => {
    const grouped = new Map<string, AlbumPhoto[]>();
    for (const photo of photos) {
      const key = formatDay(photoTime(photo));
      grouped.set(key, [...(grouped.get(key) || []), photo]);
    }
    return [...grouped.entries()];
  }, [photos]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>AI Drive · Photo timeline</span>
          <h1>相册</h1>
          <p>按拍摄时间排序；没有拍摄信息的图片会按上传时间排列。</p>
        </div>
        <div className={styles.headerActions}>
          <input
            ref={uploadInputRef}
            className={styles.uploadInput}
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => void uploadPhotos(event.target.files)}
          />
          <Button type="primary" icon={<Upload size={16} />} loading={uploading} onClick={() => uploadInputRef.current?.click()}>
            上传照片
          </Button>
          <Button icon={<RefreshCw size={16} />} loading={refreshing} onClick={() => void loadPhotos(true)}>
            刷新相册
          </Button>
        </div>
      </header>
      {actionError ? <p className={styles.actionError}>{actionError}</p> : null}

      {loading ? (
        <div className={styles.loading}><Spin size="large" /></div>
      ) : error ? (
        <section className={styles.messageState}>
          <Image size={32} />
          <strong>相册暂时不可用</strong>
          <p>{error}</p>
          <Button onClick={() => void loadPhotos(true)}>重试</Button>
        </section>
      ) : photos.length === 0 ? (
        <section className={styles.messageState}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="AI Drive 中还没有图片" />
          <p>将图片上传到 AI Drive 后，刷新此页面即可看到它们。</p>
        </section>
      ) : (
        <>
          <div className={styles.summary}>
            <CalendarDays size={16} />
            <span>共 {total} 张图片</span>
            <Tag color="green">拍摄时间优先</Tag>
          </div>
          {groups.map(([date, items]) => (
            <section className={styles.dateGroup} key={date}>
              <h2>{date}<span>{items.length} 张</span></h2>
              <div className={styles.grid}>
                {items.map((photo) => (
                  <button
                    className={styles.photoCard}
                    key={photo.file_id}
                    onClick={() => setSelectedPhoto(photo)}
                    title={photo.display_name || photo.filename}
                  >
                    <img src={imageUrl(photo.file_id)} alt={photo.display_name || photo.filename} loading="lazy" />
                    <span className={styles.cardShade}>
                      <strong>{photo.display_name || photo.filename}</strong>
                      <small>{formatTime(photoTime(photo))}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <Modal
        open={Boolean(selectedPhoto)}
        footer={
          selectedPhoto ? (
            <Popconfirm
              title="将这张图片移入 AI Drive 回收站？"
              description="之后可以在 AI Drive 回收站中恢复。"
              okText="移入回收站"
              cancelText="取消"
              onConfirm={() => void deletePhoto()}
            >
              <Button danger icon={<Trash2 size={16} />} loading={deleting}>
                删除照片
              </Button>
            </Popconfirm>
          ) : null
        }
        centered
        width={920}
        title={selectedPhoto?.display_name || selectedPhoto?.filename}
        onCancel={() => setSelectedPhoto(null)}
      >
        {selectedPhoto ? (
          <div className={styles.preview}>
            <img src={imageUrl(selectedPhoto.file_id)} alt={selectedPhoto.display_name || selectedPhoto.filename} />
            <div className={styles.photoInfo}>
              <span><CalendarDays size={15} />{formatDay(photoTime(selectedPhoto))} {formatTime(photoTime(selectedPhoto))}</span>
              {selectedPhoto.camera_model ? <span><Camera size={15} />{[selectedPhoto.camera_make, selectedPhoto.camera_model].filter(Boolean).join(" ")}</span> : null}
              {selectedPhoto.gps_lat != null && selectedPhoto.gps_lon != null ? <span><MapPin size={15} />已记录拍摄位置</span> : null}
              {selectedPhoto.summary ? <p>{selectedPhoto.summary}</p> : null}
              {selectedPhoto.tags?.length ? <div>{selectedPhoto.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</div> : null}
            </div>
          </div>
        ) : null}
      </Modal>
    </main>
  );
}
