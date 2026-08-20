import type { Metadata } from "next";
import { Noto_Sans_SC, Newsreader } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const sans = Noto_Sans_SC({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const display = Newsreader({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "旅屿 · AI 友好的酒店预订";
  const description = "让酒店、旅行者和 AI 在同一套可信价格、库存、账单与授权规则下完成预订。";

  return {
    title: {
      default: title,
      template: "%s · 旅屿",
    },
    description,
    icons: {
      icon: "/og.png",
      shortcut: "/og.png",
    },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
      images: [{ url: `${origin}/og.png`, width: 1536, height: 896, alt: "旅屿：AI 找房，付款由你" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${sans.variable} ${display.variable}`}>{children}</body>
    </html>
  );
}
