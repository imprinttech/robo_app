/**
 * DockingTab.tsx — ArUco marker docking control tab.
 *
 * Features:
 *  - 🔌 Dock button   → POST /api/dock   (DockRobot action goal, start=true)
 *  - ⏏  Undock button → POST /api/undock (UndockRobot action goal, start=true)
 *  - Both buttons disabled while either action is active OR while a send
 *    request is in flight (the docking controller's busy_lock rejects both
 *    action servers while one is running).
 *  - Status card polling /api/dock/status at 2 Hz to show live FSM phase,
 *    battery percentage, and goal outcome.
 */

import { useEffect, useRef, useState } from "react";
import { sendDock, sendUndock, fetchDockStatus } from "../lib/dockingApi";
import type { DockStatus } from "../lib/dockingApi";

// ── Status badge colour mapping (same vocabulary as GoalPoseTab) ──────────────
const STATUS_CLASS: Record<string, string> = {
  ACCEPTED:  "badge--ok",
  EXECUTING: "badge--ok",
  SUCCEEDED: "badge--ok",
  CANCELED:  "badge--warn",
  CANCELING: "badge--warn",
  ABORTED:   "badge--err",
  UNKNOWN:   "badge--dim",
};

// ── Component ─────────────────────────────────────────────────────────────────

export function DockingTab() {
  const [dockStatus, setDockStatus] = useState<DockStatus | null>(null);
  const [sending,    setSending]    = useState<"dock" | "undock" | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Poll docking status at 2 Hz ───────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const s = await fetchDockStatus();
        setDockStatus(s);
      } catch { /* non-fatal — server may be starting up */ }
    };
    poll();
    pollRef.current = setInterval(poll, 500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleDock = async () => {
    setSending("dock");
    setError(null);
    try {
      const res = await sendDock();
      if (!res.ok) setError("Docking goal rejected by action server.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send dock goal");
    } finally {
      setSending(null);
    }
  };

  const handleUndock = async () => {
    setSending("undock");
    setError(null);
    try {
      const res = await sendUndock();
      if (!res.ok) setError("Undocking goal rejected by action server.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send undock goal");
    } finally {
      setSending(null);
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────────
  // Disable both buttons while any action is in flight on the ROS side or
  // while we have a pending HTTP request.
  const rosActive = dockStatus?.active ?? false;
  const busy      = rosActive || sending !== null;

  const statusStr  = dockStatus?.status ?? "UNKNOWN";
  const actionStr  = dockStatus?.action ?? null;
  const phaseStr   = dockStatus?.phase  ?? "";
  const batteryPct = dockStatus?.battery_percentage ?? 0.0;

  return (
    <div className="docking-tab">

      {/* ── Docking Controls card ──────────────────────────────────────── */}
      <div className="card docking-controls-card">
        <div className="card__title">Docking Controls</div>

        {error && (
          <p className="goalpose-error">{error}</p>
        )}

        <div className="docking-actions">
          <button
            id="btn-dock"
            className="btn btn--primary"
            onClick={handleDock}
            disabled={busy}
          >
            {sending === "dock" ? "Docking…" : "🔌 Dock"}
          </button>

          <button
            id="btn-undock"
            className="btn btn--secondary"
            onClick={handleUndock}
            disabled={busy}
          >
            {sending === "undock" ? "Undocking…" : "⏏ Undock"}
          </button>
        </div>

        {rosActive && (
          <p className="docking-hint">
            ⚙️ {actionStr === "dock" ? "Docking" : "Undocking"} in progress — buttons locked until complete.
          </p>
        )}
      </div>

      {/* ── Docking Status card ────────────────────────────────────────── */}
      <div className="card docking-status-card">
        <div className="card__title">Docking Status</div>
        {dockStatus ? (
          <dl className="status-dl">
            <div className="status-row">
              <dt>Status</dt>
              <dd>
                <span className={`badge ${STATUS_CLASS[statusStr] ?? "badge--dim"}`}>
                  {statusStr}
                </span>
              </dd>
            </div>

            <div className="status-row">
              <dt>Action</dt>
              <dd className="mono">{actionStr ?? "—"}</dd>
            </div>

            {phaseStr && (
              <div className="status-row">
                <dt>Phase</dt>
                <dd className="mono">{phaseStr}</dd>
              </div>
            )}

            {rosActive && batteryPct > 0 && (
              <div className="status-row">
                <dt>Battery</dt>
                <dd className="mono">{batteryPct.toFixed(1)}%</dd>
              </div>
            )}

            {dockStatus.goal_id && (
              <div className="status-row">
                <dt>Goal ID</dt>
                <dd className="mono" style={{ fontSize: "0.7rem", wordBreak: "break-all" }}>
                  {dockStatus.goal_id.slice(0, 8)}…
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="status-idle">Polling…</p>
        )}
      </div>

    </div>
  );
}
