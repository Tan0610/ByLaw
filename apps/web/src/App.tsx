import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { USE_MOCKS } from "./lib/config";
import { useLiveUpdates } from "./lib/hooks";
import { MOCK_ACCOUNTS, useWallet } from "./lib/wallet";
import AgentsPage from "./pages/AgentsPage";
import CharterPage from "./pages/CharterPage";
import DaoPage from "./pages/DaoPage";
import JobDetailPage from "./pages/JobDetailPage";
import JobsPage from "./pages/JobsPage";
import SeatsPage from "./pages/SeatsPage";
import TreasuryPage from "./pages/TreasuryPage";

const NAV = [
  ["/", "Charter"], ["/dao", "DAO"], ["/agents", "Agents"], ["/jobs", "Jobs"], ["/treasury", "Treasury"], ["/seats", "Seats"],
] as const;

function ThemeToggle() {
  const [theme, setTheme] = useState<"auto" | "light" | "dark">(() => {
    try { return (localStorage.getItem("charter.theme") as "light" | "dark" | null) ?? "auto"; } catch { return "auto"; }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "auto") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", theme);
    try { theme === "auto" ? localStorage.removeItem("charter.theme") : localStorage.setItem("charter.theme", theme); } catch { /* ignore */ }
  }, [theme]);
  const next = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  return <button className="sm" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`}>Theme: {theme}</button>;
}

function WalletButton() {
  const w = useWallet();
  if (w.mode === "mock") {
    return (
      <div className="row">
        <label htmlFor="acct" className="sr-only">Mock account</label>
        <select id="acct" style={{ width: "auto", minHeight: 32 }} value={w.accountId ?? ""} onChange={(e) => (e.target.value ? w.setMockAccount(e.target.value) : void w.disconnect())}>
          <option value="">Not connected</option>
          {MOCK_ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
    );
  }
  return w.accountId ? (
    <div className="row"><span className="mono small break">{w.accountId}</span><button className="sm" onClick={() => void w.disconnect()}>Disconnect</button></div>
  ) : <button className="primary sm" onClick={w.connect} disabled={!w.ready}>Connect wallet</button>;
}

export default function App() {
  useLiveUpdates();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      {USE_MOCKS && <div className="banner" role="note">Mock mode: demo data, no network, nothing is sent to NEAR.</div>}
      <header className="top">
        <div className="top-inner">
          <NavLink to="/" className="brand" end>
            <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M9 9h14v3H9zm0 5.5h14v3H9zM9 20h9v3H9z" fill="var(--accent-ink)" /></svg>
            Charter
          </NavLink>
          <nav className="main" aria-label="Main">
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>)}
          </nav>
          <div className="top-actions"><ThemeToggle /><WalletButton /></div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<CharterPage />} />
          <Route path="/dao" element={<DaoPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/treasury" element={<TreasuryPage />} />
          <Route path="/seats" element={<SeatsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <footer className="foot">Charter runs on NEAR testnet only. Agents are untrusted: the contract enforces budgets, roles and the revenue split.</footer>
    </>
  );
}
