/**
 * GoalPoseTab.tsx — Nav2 goal-pose navigation tab.
 *
 * Features:
 *  - Loads the occupancy map once on mount (GET /api/map).
 *  - Polls robot pose (GET /api/pose) at 2 Hz while the tab is mounted.
 *  - Polls nav status (GET /api/nav/goal/status) at 2 Hz.
 *  - Two-click goal placement on the map canvas:
 *      1st click → set XY position
 *      2nd click → set heading (direction from 1st to 2nd click point)
 *  - Manual goal input fields (X, Y, Yaw°) as an alternative to clicking.
 *  - Send / Cancel buttons with status display.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MapCanvas } from "../components/MapCanvas";
import {
  fetchMap, fetchPose, fetchNavStatus, sendGoal, publishPauseNavigation,
} from "../lib/mapApi";
import type { MapData, RobotPose, NavStatus } from "../lib/mapApi";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GoalPose { x: number; y: number; yaw_deg: number; }

// ── Status badge colours ───────────────────────────────────────────────────────
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

export function GoalPoseTab() {
  // Map
  const [mapData,     setMapData]     = useState<MapData | null>(null);
  const [mapLoading,  setMapLoading]  = useState(true);
  const [mapError,    setMapError]    = useState<string | null>(null);

  // Robot pose
  const [robotPose,   setRobotPose]   = useState<RobotPose | null>(null);
  const [poseError,   setPoseError]   = useState<string | null>(null);

  // Goal placement
  const [goalPose,    setGoalPose]    = useState<GoalPose | null>(null);
  const [manualX,     setManualX]     = useState("0.00");
  const [manualY,     setManualY]     = useState("0.00");
  const [manualYaw,   setManualYaw]   = useState("0");

  // Nav status
  const [navStatus,   setNavStatus]   = useState<NavStatus | null>(null);

  // Send / pause UI
  const [sending,     setSending]     = useState(false);
  const [sendError,   setSendError]   = useState<string | null>(null);
  const [paused,      setPaused]      = useState(false);
  const [pausing,     setPausing]     = useState(false);

  // Poll intervals
  const poseIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load map once on mount ─────────────────────────────────────────────────
  useEffect(() => {
    setMapLoading(true);
    fetchMap()
      .then((m) => { setMapData(m); setMapError(null); })
      .catch((e: Error) => setMapError(e.message))
      .finally(() => setMapLoading(false));
  }, []);

  // ── Poll pose ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const p = await fetchPose();
        setRobotPose(p);
        setPoseError(null);
      } catch (e: unknown) {
        setPoseError(e instanceof Error ? e.message : "Pose error");
      }
    };
    poll();
    poseIntervalRef.current = setInterval(poll, 500);
    return () => {
      if (poseIntervalRef.current) clearInterval(poseIntervalRef.current);
    };
  }, []);

  // ── Poll nav status ────────────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const s = await fetchNavStatus();
        setNavStatus(s);
      } catch { /* non-fatal */ }
    };
    poll();
    statusIntervalRef.current = setInterval(poll, 500);
    return () => {
      if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
    };
  }, []);

  // ── Goal placement from map canvas ─────────────────────────────────────────
  const handleGoalSet = useCallback((pose: GoalPose) => {
    setGoalPose(pose);
    setManualX(pose.x.toFixed(3));
    setManualY(pose.y.toFixed(3));
    setManualYaw(pose.yaw_deg.toFixed(1));
    setSendError(null);
  }, []);

  // ── Send goal ──────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const x   = parseFloat(manualX);
    const y   = parseFloat(manualY);
    const yaw = parseFloat(manualYaw);
    if (isNaN(x) || isNaN(y) || isNaN(yaw)) {
      setSendError("Invalid goal coordinates");
      return;
    }
    setSending(true);
    setSendError(null);
    // Always start a fresh goal unpaused
    if (paused) {
      try { await publishPauseNavigation(false); } catch { /* best-effort */ }
      setPaused(false);
    }
    try {
      await sendGoal({ x, y, yaw_deg: yaw });
      setGoalPose({ x, y, yaw_deg: yaw });
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : "Failed to send goal");
    } finally {
      setSending(false);
    }
  };

  // ── Stop / Resume (BT pause) ───────────────────────────────────────────────
  const handleToggleStop = async () => {
    setPausing(true);
    setSendError(null);
    try {
      if (!paused) {
        await publishPauseNavigation(true);
        setPaused(true);
      } else {
        await publishPauseNavigation(false);
        setPaused(false);
      }
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : "Pause toggle failed");
    } finally {
      setPausing(false);
    }
  };

  // ── Reload map ─────────────────────────────────────────────────────────────
  const handleReloadMap = () => {
    setMapLoading(true);
    setMapError(null);
    fetchMap()
      .then((m) => { setMapData(m); setMapError(null); })
      .catch((e: Error) => setMapError(e.message))
      .finally(() => setMapLoading(false));
  };

  // ── Status helpers ─────────────────────────────────────────────────────────
  const statusStr = navStatus?.status ?? "UNKNOWN";
  const isActive  = navStatus?.active ?? false;

  return (
    <div className="goalpose-tab">

      {/* ── Left panel: Map ─────────────────────────────────────────────── */}
      <section className="goalpose-map-panel">
        <div className="card">
          <div className="card__title-row">
            <span className="card__title">Occupancy Map</span>
            <button
              id="btn-reload-map"
              className="icon-btn"
              onClick={handleReloadMap}
              disabled={mapLoading}
              title="Reload map"
            >
              {mapLoading ? "⏳" : "🔄"}
            </button>
          </div>
          <MapCanvas
            mapData={mapData}
            robotPose={robotPose}
            goalPose={goalPose}
            onGoalSet={handleGoalSet}
            loading={mapLoading}
            error={mapError}
          />
          {mapData && !mapLoading && (
            <p className="map-meta">
              {mapData.width} × {mapData.height} cells &nbsp;·&nbsp;
              {mapData.resolution}m/cell &nbsp;·&nbsp;
              {(mapData.width * mapData.resolution).toFixed(1)} × {(mapData.height * mapData.resolution).toFixed(1)} m
            </p>
          )}
        </div>
      </section>

      {/* ── Right panel: Controls ─────────────────────────────────────────── */}
      <aside className="goalpose-controls-panel">

        {/* Robot Pose */}
        <div className="card">
          <div className="card__title">Robot Pose (AMCL)</div>
          {poseError ? (
            <p className="pose-unavailable">
              {poseError.includes("404") ? "Waiting for AMCL…" : poseError}
            </p>
          ) : robotPose ? (
            <dl className="status-dl">
              <div className="status-row">
                <dt>X</dt>
                <dd className="mono">{robotPose.x.toFixed(3)} m</dd>
              </div>
              <div className="status-row">
                <dt>Y</dt>
                <dd className="mono">{robotPose.y.toFixed(3)} m</dd>
              </div>
              <div className="status-row">
                <dt>Yaw</dt>
                <dd className="mono">{robotPose.yaw_deg.toFixed(1)} °</dd>
              </div>
            </dl>
          ) : (
            <p className="pose-unavailable">No pose yet</p>
          )}
        </div>

        {/* Goal Placement */}
        <div className="card">
          <div className="card__title">Navigation Goal</div>
          <p className="goalpose-hint">
            📍 Click the map to place a goal (1st click = position, 2nd = heading).
            Or enter coordinates manually:
          </p>
          <div className="goalpose-fields">
            <label htmlFor="goal-x" className="goalpose-label">X (m)</label>
            <input
              id="goal-x"
              type="number"
              step="0.01"
              className="goalpose-input"
              value={manualX}
              onChange={(e) => setManualX(e.target.value)}
            />

            <label htmlFor="goal-y" className="goalpose-label">Y (m)</label>
            <input
              id="goal-y"
              type="number"
              step="0.01"
              className="goalpose-input"
              value={manualY}
              onChange={(e) => setManualY(e.target.value)}
            />

            <label htmlFor="goal-yaw" className="goalpose-label">Yaw (°)</label>
            <input
              id="goal-yaw"
              type="number"
              step="1"
              className="goalpose-input"
              value={manualYaw}
              onChange={(e) => setManualYaw(e.target.value)}
            />
          </div>

          {sendError && (
            <p className="goalpose-error">{sendError}</p>
          )}

          <div className="goalpose-actions">
            <button
              id="btn-send-goal"
              className="btn btn--primary"
              onClick={handleSend}
              disabled={sending || pausing}
            >
              {sending ? "Sending…" : "🎯 Send Goal"}
            </button>
            <button
              id="btn-toggle-stop"
              className={paused ? "btn btn--resume" : "btn btn--stop"}
              onClick={handleToggleStop}
              disabled={pausing || sending}
            >
              {pausing
                ? (paused ? "Resuming…" : "Stopping…")
                : (paused ? "▶ Resume" : "⏸ Stop")}
            </button>
          </div>
        </div>

        {/* Navigation Status */}
        <div className="card">
          <div className="card__title">Navigation Status</div>
          {navStatus ? (
            <dl className="status-dl">
              <div className="status-row">
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${STATUS_CLASS[statusStr] ?? "badge--dim"}`}>
                    {statusStr}
                  </span>
                </dd>
              </div>
              {navStatus.goal_id && (
                <div className="status-row">
                  <dt>Goal ID</dt>
                  <dd className="mono" style={{ fontSize: "0.7rem", wordBreak: "break-all" }}>
                    {navStatus.goal_id.slice(0, 8)}…
                  </dd>
                </div>
              )}
              {isActive && (
                <div className="status-row">
                  <dt>Distance</dt>
                  <dd className="mono">{navStatus.distance_remaining.toFixed(2)} m</dd>
                </div>
              )}
              {goalPose && (
                <>
                  <div className="status-row">
                    <dt>Goal X</dt>
                    <dd className="mono">{goalPose.x.toFixed(3)} m</dd>
                  </div>
                  <div className="status-row">
                    <dt>Goal Y</dt>
                    <dd className="mono">{goalPose.y.toFixed(3)} m</dd>
                  </div>
                  <div className="status-row">
                    <dt>Goal Yaw</dt>
                    <dd className="mono">{goalPose.yaw_deg.toFixed(1)} °</dd>
                  </div>
                </>
              )}
            </dl>
          ) : (
            <p className="status-idle">Polling…</p>
          )}
        </div>

      </aside>
    </div>
  );
}
