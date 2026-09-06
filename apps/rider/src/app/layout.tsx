import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Rider",
  description: "Delivery stops, navigation, and cash collection",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Rider" },
};

export const viewport: Viewport = {
  themeColor: "#0B2B26",
  // Riders tap while walking; a stray double-tap must not zoom the page, but
  // pinch-zoom stays available for anyone who needs it.
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
