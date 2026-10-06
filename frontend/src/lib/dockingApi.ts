/**
 * dockingApi.ts — Typed fetch wrappers for docking action endpoints.
 *
 * All calls proxy through /api → FastAPI backend (port 8090).
 *
 * Endpoints:
 *   POST /api/dock         → send DockRobot goal
 *   POST /api/undock       → send UndockRobot goal
 *   GET  /api/dock/status  → cached docking status (no ROS poll per request)
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DockStatus {
  active: boolean;
  /** "dock" | "undock" | null */
  action: "dock" | "undock" | null;
  /** ACCEPTED | EXECUTING | SUCCEEDED | CANCELED | ABORTED | CANCELING | UNKNOWN */
  status: string;
  /** Current FSM phase reported by feedback callback (e.g. "NAVIGATING", "APPROACHING") */
  phase: string;
  /** Battery percentage reported by feedback, 0–100 */
  battery_percentage: number;
  goal_id: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _post(path: string): Promise<{ ok: boolean; goal_id: string }> {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Exports ───────────────────────────────────────────────────────────────────

export async function sendDock(): Promise<{ ok: boolean; goal_id: string }> {
  return _post("/api/dock");
}

export async function sendUndock(): Promise<{ ok: boolean; goal_id: string }> {
  return _post("/api/undock");
}

export async function fetchDockStatus(): Promise<DockStatus> {
  const res = await fetch(`${API_BASE}/api/dock/status`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}
