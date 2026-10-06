/**
 * mapApi.ts — Typed fetch wrappers for map, pose, and navigation endpoints.
 *
 * All calls proxy through /api → FastAPI backend (port 8090).
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// ── Map ───────────────────────────────────────────────────────────────────────

export interface MapData {
  /** Map width in cells */
  width: number;
  /** Map height in cells */
  height: number;
  /** Metres per cell */
  resolution: number;
  /** Map origin X in world (metres) */
  origin_x: number;
  /** Map origin Y in world (metres) */
  origin_y: number;
  /**
   * Flat row-major occupancy values (ROS convention: row 0 = bottom-left).
   * Values: -1 = unknown, 0 = free, 1–100 = occupied.
   */
  data: number[];
}

export async function fetchMap(): Promise<MapData> {
  const res = await fetch(`${API_BASE}/api/map`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Robot Pose ────────────────────────────────────────────────────────────────

export interface RobotPose {
  /** X position in map frame (metres) */
  x: number;
  /** Y position in map frame (metres) */
  y: number;
  /** Heading in degrees (0 = East, counter-clockwise positive) */
  yaw_deg: number;
}

export async function fetchPose(): Promise<RobotPose | null> {
  const res = await fetch(`${API_BASE}/api/pose`);
  if (res.status === 404) return null; // AMCL not ready yet
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Navigation ────────────────────────────────────────────────────────────────

export interface GoalRequest {
  x: number;
  y: number;
  yaw_deg: number;
}

export interface GoalResponse {
  ok: boolean;
  goal_id: string;
}

export interface NavStatus {
  active: boolean;
  goal_id: string;
  /** "ACCEPTED" | "EXECUTING" | "SUCCEEDED" | "CANCELED" | "UNKNOWN" */
  status: string;
  distance_remaining: number;
}

export async function sendGoal(req: GoalRequest): Promise<GoalResponse> {
  const res = await fetch(`${API_BASE}/api/nav/goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchNavStatus(): Promise<NavStatus> {
  const res = await fetch(`${API_BASE}/api/nav/goal/status`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function cancelGoal(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/nav/goal`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
}

// ── Pause / Resume via BT PauseCondition ─────────────────────────────────────

/**
 * Publish a std_msgs/Bool to /pause_navigation.
 * The PauseCondition BT node in the nav tree reads this topic:
 *   true  → navigation paused (robot holds position, goal stays active)
 *   false → navigation resumed
 */
export async function publishPauseNavigation(paused: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/api/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "/pause_navigation",
      msg_type: "std_msgs/msg/Bool",
      data: { data: paused },
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.detail ?? `HTTP ${res.status}`);
  }
}
