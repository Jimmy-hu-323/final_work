import { Glasses, Images, Map, MessageCircle, Settings2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import styles from "../index.module.less";

const ITEMS = [
  { path: "/lensgo", label: "LensGo", icon: Glasses },
  { path: "/chat", label: "对话", icon: MessageCircle },
  { path: "/travel-planner", label: "旅程", icon: Map },
  { path: "/travel-album", label: "相册", icon: Images },
  { path: "/models", label: "设置", icon: Settings2 },
];

export default function MobileNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <nav className={styles.mobileNavigation} aria-label="手机主导航">
      {ITEMS.map(({ path, label, icon: Icon }) => {
        const active = location.pathname.startsWith(path);
        return (
          <button
            key={path}
            type="button"
            className={active ? styles.mobileNavigationActive : ""}
            onClick={() => navigate(path)}
          >
            <Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
