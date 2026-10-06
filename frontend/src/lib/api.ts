/**
 * api.ts — Typed fetch wrapper for the backend REST API.
 *
 * All calls go through a single `apiFetch` function so base URL changes,
 * auth headers, or error normalisation only need updating here.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface KnownTopic {
  topic: string;
  msg_type: string;
}

export interface PublishRequest {
  topic: string;
  msg_type: string;
  data: Record<string, unknown>;
}

export interface PublishResponse {
  ok: boolean;
  topic: string;
  msg_type: string;
  zenoh_status: number;
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    ...options,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch { /* non-JSON body — keep status string */ }
    throw new Error(detail);
  }

  return res.json() as Promise<T>;
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Fetch the list of well-known robot cmd_vel topics from the backend.
 */
export async function fetchKnownTopics(): Promise<KnownTopic[]> {
  return apiFetch<KnownTopic[]>("/api/topics/known");
}

/**
 * Publish a ROS 2 message via the backend → Zenoh REST bridge.
 * The backend handles CDR serialization and TwistStamped wrapping.
 */
export async function publishTopic(
  req: PublishRequest
): Promise<PublishResponse> {
  return apiFetch<PublishResponse>("/api/publish", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
