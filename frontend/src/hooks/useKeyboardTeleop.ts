/**
 * useKeyboardTeleop.ts — Hook for keyboard and on-screen-button teleoperation.
 *
 * Key bindings:
 *   W  → forward  (+linear.x)
 *   S  → backward (-linear.x)
 *   A  → rotate left  (+angular.z)
 *   D  → rotate right (-angular.z)
 *   X  → HARD STOP (zero everything, cancel held-key state)
 *
 * Safety measures:
 *   - A final zero-velocity message is sent on keyup.
 *   - A zero-velocity message is sent on window blur.
 *   - A zero-velocity message is sent when the tab becomes hidden (visibilitychange).
 *   - The 10 Hz interval is cleared on cleanup.
 *
 * The hook exposes `startKey` / `stopKey` so on-screen buttons (mouse/touch)
 * can trigger the same logic without a keyboard.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { publishTopic } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TeleopKey = "w" | "s" | "a" | "d" | "x";

export interface TeleopConfig {
  topic: string;
  msgType: string;
  linearSpeed: number;   // m/s  (e.g. 0.3)
  angularSpeed: number;  // rad/s (e.g. 0.6)
}

export interface PublishStatus {
  lastTopic: string | null;
  lastTimestamp: string | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface UseTeleopReturn {
  publishStatus: PublishStatus;
  activeKeys: Set<TeleopKey>;
  /** Call when a button is pressed (mousedown / touchstart) */
  startKey: (key: TeleopKey) => void;
  /** Call when a button is released (mouseup / mouseleave / touchend) */
  stopKey: (key: TeleopKey) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PUBLISH_HZ = 10; // publish rate while keys are held
const PUBLISH_INTERVAL_MS = Math.round(1000 / PUBLISH_HZ);

// ── Velocity math ─────────────────────────────────────────────────────────────

function keysToTwist(
  keys: Set<TeleopKey>,
  linearSpeed: number,
  angularSpeed: number
) {
  let lx = 0;
  let az = 0;
  if (keys.has("w")) lx += linearSpeed;
  if (keys.has("s")) lx -= linearSpeed;
  if (keys.has("a")) az += angularSpeed;
  if (keys.has("d")) az -= angularSpeed;
  return { linear: { x: lx, y: 0, z: 0 }, angular: { x: 0, y: 0, z: az } };
}

const ZERO_TWIST = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useKeyboardTeleop(config: TeleopConfig): UseTeleopReturn {
  const { topic, msgType, linearSpeed, angularSpeed } = config;

  // Track which keys are currently held
  const activeKeysRef = useRef<Set<TeleopKey>>(new Set());
  const [activeKeys, setActiveKeys] = useState<Set<TeleopKey>>(new Set());

  // Interval handle for the 10 Hz publish loop
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Status shown in the UI
  const [publishStatus, setPublishStatus] = useState<PublishStatus>({
    lastTopic: null,
    lastTimestamp: null,
    lastOk: null,
    lastError: null,
  });

  // ── Publish helpers ─────────────────────────────────────────────────────────

  const doPublish = useCallback(
    async (twist: typeof ZERO_TWIST) => {
      try {
        await publishTopic({ topic, msg_type: msgType, data: twist });
        setPublishStatus({
          lastTopic: topic,
          lastTimestamp: new Date().toLocaleTimeString(),
          lastOk: true,
          lastError: null,
        });
      } catch (err) {
        setPublishStatus({
          lastTopic: topic,
          lastTimestamp: new Date().toLocaleTimeString(),
          lastOk: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [topic, msgType]
  );

  const publishZero = useCallback(() => doPublish(ZERO_TWIST), [doPublish]);

  // ── Interval management ─────────────────────────────────────────────────────

  const startInterval = useCallback(() => {
    if (intervalRef.current !== null) return; // already running
    intervalRef.current = setInterval(() => {
      const keys = activeKeysRef.current;
      if (keys.size === 0) return;
      const twist = keysToTwist(keys, linearSpeed, angularSpeed);
      doPublish(twist);
    }, PUBLISH_INTERVAL_MS);
  }, [doPublish, linearSpeed, angularSpeed]);

  const stopInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ── Key state management ────────────────────────────────────────────────────

  const startKey = useCallback(
    (key: TeleopKey) => {
      if (key === "x") {
        // Hard stop: clear everything immediately
        activeKeysRef.current.clear();
        setActiveKeys(new Set());
        stopInterval();
        publishZero();
        return;
      }
      activeKeysRef.current.add(key);
      setActiveKeys(new Set(activeKeysRef.current));
      // Publish immediately on first press (don't wait for interval tick)
      const twist = keysToTwist(activeKeysRef.current, linearSpeed, angularSpeed);
      doPublish(twist);
      startInterval();
    },
    [doPublish, publishZero, startInterval, stopInterval, linearSpeed, angularSpeed]
  );

  const stopKey = useCallback(
    (key: TeleopKey) => {
      if (key === "x") return; // X is handled in startKey
      activeKeysRef.current.delete(key);
      setActiveKeys(new Set(activeKeysRef.current));
      if (activeKeysRef.current.size === 0) {
        stopInterval();
      }
      // Safety: always send a zero on key release
      publishZero();
    },
    [publishZero, stopInterval]
  );

  // ── Keyboard event listeners ────────────────────────────────────────────────

  useEffect(() => {
    const VALID: Set<string> = new Set(["w", "s", "a", "d", "x"]);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return; // ignore auto-repeat
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (VALID.has(key)) {
        e.preventDefault();
        startKey(key as TeleopKey);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (VALID.has(key)) stopKey(key as TeleopKey);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [startKey, stopKey]);

  // ── Safety: stop on blur / hidden tab ──────────────────────────────────────

  useEffect(() => {
    const handleBlur = () => {
      activeKeysRef.current.clear();
      setActiveKeys(new Set());
      stopInterval();
      publishZero();
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") handleBlur();
    };

    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [publishZero, stopInterval]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopInterval();
      // Don't send zero on unmount — avoids a publish to a stale topic
    };
  }, [stopInterval]);

  return { publishStatus, activeKeys, startKey, stopKey };
}
