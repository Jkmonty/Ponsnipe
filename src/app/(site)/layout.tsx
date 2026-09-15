import { Fraunces, JetBrains_Mono, Patrick_Hand } from "next/font/google";
import "./site.css";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";

/*
 * Fonts through next/font, which downloads them at build time and serves them
 * from this origin. That is what makes them legal under the production CSP's
 * font-src 'self'. If the container build ever runs without network, swap
 * these two calls for next/font/local with the files committed under ./fonts.
 */
/* The one handwritten note on the site, pointing at the target. */
const hand = Patrick_Hand({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-hand",
  display: "swap",
});

const display = Fraunces({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  axes: ["opsz", "SOFT"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-mono-site",
  display: "swap",
});

/**
 * The site shell: nav, page, footer.
 *
 * Nested under the root layout, not a second root, so moving between the
 * site and the terminal is a client navigation rather than a full reload.
 * Everything Sherwood is scoped under .site; the terminal never sees it.
 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`site ${display.variable} ${mono.variable} ${hand.variable}`}>
      <SiteNav />
      {children}
      <SiteFooter />
    </div>
  );
}
