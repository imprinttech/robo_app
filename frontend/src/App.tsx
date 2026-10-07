/**
 * App.tsx — Top-level application shell.
 *
 * Tab structure:
 *   - Teleop      → ACTIVE (TeleopTab)
 *   - Goal Pose   → disabled placeholder ("Coming soon")
 *   - SLAM Map    → disabled placeholder ("Coming soon")
 *   - Settings    → disabled placeholder ("Coming soon")
 *
 * Adding a new tab:
 *   1. Import your tab component.
 *   2. Add an entry to TABS with disabled: false.
 *   3. Add a case to renderTab().
 */

import { useState } from "react";
import { TeleopTab } from "./tabs/TeleopTab";
import { GoalPoseTab } from "./tabs/GoalPoseTab";
import { DockingTab } from "./tabs/DockingTab";
import "./App.css";

// ── Tab registry ──────────────────────────────────────────────────────────────

type TabId = "teleop" | "goalpose" | "docking" | "slammap" | "settings";

interface Tab {
  id: TabId;
  label: string;
  icon: string;
  disabled: boolean;
}

const TABS: Tab[] = [
  { id: "teleop",   label: "Teleop",    icon: "🕹️",  disabled: false },
  { id: "goalpose", label: "Goal Pose", icon: "🎯",  disabled: false },
  { id: "docking",  label: "Docking",   icon: "🔌",  disabled: false },
  { id: "slammap",  label: "SLAM Map",  icon: "🗺️",  disabled: true  },
  { id: "settings", label: "Settings",  icon: "⚙️",  disabled: true  },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("teleop");

  return (
    <div className="app">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__logo" aria-hidden="true">🤖</span>
          <div>
            <h1 className="app-header__title">Warehouse Robot</h1>
            <p className="app-header__subtitle">Control Dashboard</p>
          </div>
        </div>
        <div className="app-header__status-dot" title="Connected" />
      </header>

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <nav className="tab-bar" role="tablist" aria-label="Dashboard tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-btn-${tab.id}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            disabled={tab.disabled}
            className={[
              "tab-bar__btn",
              activeTab === tab.id ? "tab-bar__btn--active" : "",
              tab.disabled         ? "tab-bar__btn--disabled" : "",
            ].join(" ")}
            onClick={() => !tab.disabled && setActiveTab(tab.id)}
            title={tab.disabled ? "Coming soon" : tab.label}
          >
            <span className="tab-bar__icon" aria-hidden="true">{tab.icon}</span>
            <span className="tab-bar__label">{tab.label}</span>
            {tab.disabled && (
              <span className="tab-bar__badge">Soon</span>
            )}
          </button>
        ))}
      </nav>

      {/* ── Tab panel ───────────────────────────────────────────────────── */}
      <main className="tab-panel">
        <div
          id="tabpanel-teleop"
          role="tabpanel"
          aria-labelledby="tab-btn-teleop"
          className={`tab-pane ${activeTab === "teleop" ? "tab-pane--active" : "tab-pane--hidden"}`}
        >
          <TeleopTab isActive={activeTab === "teleop"} />
        </div>

        <div
          id="tabpanel-goalpose"
          role="tabpanel"
          aria-labelledby="tab-btn-goalpose"
          className={`tab-pane ${activeTab === "goalpose" ? "tab-pane--active" : "tab-pane--hidden"}`}
        >
          <GoalPoseTab />
        </div>

        <div
          id="tabpanel-docking"
          role="tabpanel"
          aria-labelledby="tab-btn-docking"
          className={`tab-pane ${activeTab === "docking" ? "tab-pane--active" : "tab-pane--hidden"}`}
        >
          <DockingTab />
        </div>

        {activeTab !== "teleop" && activeTab !== "goalpose" && activeTab !== "docking" && (
          <div className="tab-soon">
            <div className="tab-soon__icon">🚧</div>
            <h2>Coming Soon</h2>
            <p>This tab is under construction. Check back after the Teleop tab is stable.</p>
          </div>
        )}
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="app-footer">
        ROS 2 Warehouse Robot Dashboard · Teleop MVP · Domain ID 88
      </footer>
    </div>
  );
}
