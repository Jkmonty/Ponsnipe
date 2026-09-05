import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ponsnipe",
  description:
    "Snipe and auto-exit pons.family tokens on Robinhood Chain — take-profit, stop-loss and a graduation exit that fire without you.",
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
