import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Shop admin",
  description: "Orders, products, riders and operations",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
