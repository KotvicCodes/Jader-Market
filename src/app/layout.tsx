import type { Metadata } from "next";
import Link from "next/link";
import { version } from "../../package.json";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Jader-Market", template: "%s | Jader-Market" },
  description: "A private-community prediction market prototype with offline settlement.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><div className="header-inner">
      <Link href="/" className="brand"><span className="brand-mark">J</span>Jader<span className="muted">Market</span></Link>
      <nav aria-label="Main navigation"><Link href="/">Markets</Link><Link href="/portfolio">Portfolio</Link><Link href="/account">Account</Link><Link href="/admin">Admin</Link></nav>
      <span className="badge">Prototype</span>
    </div></header>
    <main id="main" className="container">{children}</main>
    <footer className="container footer"><span>Closed community · Offline settlement</span><span>Jader-Market v{version}</span></footer>
  </body></html>;
}
