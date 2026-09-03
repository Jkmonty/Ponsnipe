import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "pons autotrade",
  description:
    "Buy pons.family memecoins on Robinhood Chain with automatic take-profit / stop-loss exits.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
