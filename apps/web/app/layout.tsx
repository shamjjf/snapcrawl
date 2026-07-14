import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@snapcrawl/shared/design/tokens.css";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "SnapCrawl Admin",
  description: "SnapCrawl admin panel — crawl sessions, galleries, and sitemaps.",
};

// Set the persisted theme before first paint to avoid a light/dark flash.
const NO_FLASH = `(function(){try{var t=localStorage.getItem('sc-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body className="sc-root">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
