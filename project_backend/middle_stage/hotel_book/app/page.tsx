import type { Metadata } from "next";
import { HotelApp } from "./hotel-app";

export const metadata: Metadata = {
  title: "旅屿 · AI 友好的酒店预订",
  description: "搜索酒店、管理账单，并安全地控制 AI 付款权限。",
};

export default function Home() {
  return <HotelApp />;
}
