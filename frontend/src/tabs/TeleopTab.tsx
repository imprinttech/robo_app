/**
 * TeleopTab.tsx — Full keyboard + on-screen-button teleoperation panel.
 *
 * Layout:
 *  ┌─────────────────────────────────────────────────────┐
 *  │  Topic selector (TopicField)                        │
 *  │  Speed sliders (linear / angular)                   │
 *  ├─────────────────────────────────────────────────────┤
 *  │         [W]                                         │
 *  │    [A]  [S]  [D]     [X] STOP                      │
 *  │                                                     │
 *  │  Keyboard indicator (active keys)                   │
 *  ├─────────────────────────────────────────────────────┤
 *  │  Status readout (last topic, timestamp, ok/error)   │
 *  └─────────────────────────────────────────────────────┘
 */

import { useState } from "react";
import { TopicField } from "../components/TopicField";
import { useKeyboardTeleop, type TeleopKey } from "../hooks/useKeyboardTeleop";

// ── Default speeds ─────────────────────────────────────────────────────────────

const DEFAULT_LINEAR  = 0.3;   // m/s
const DEFAULT_ANGULAR = 0.6;   // rad/s

// ── On-screen button definitions ──────────────────────────────────────────────

interface DpadButton {
  key: TeleopKey;
  label: string;
  icon: string;
  gridArea: string;
  isStop?: boolean;
}

const DPAD_BUTTONS: DpadButton[] = [
  { key: "w", label: "Forward",      icon: "▲", gridArea: "w" },
  { key: "a", label: "Rotate Left",  icon: "◀", gridArea: "a" },
  { key: "s", label: "Backward",     icon: "▼", gridArea: "s" },
  { key: "d", label: "Rotate Right", icon: "▶", gridArea: "d" },
  { key: "x", label: "STOP",         icon: "■", gridArea: "x", isStop: true },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface TeleopTabProps {
  isActive?: boolean;
}

export function TeleopTab({ isActive = true }: TeleopTabProps) {
  const [topic,   setTopic]   = useState("/cmd_vel_teleop");
  const [msgType, setMsgType] = useState("geometry_msgs/msg/Twist");
  const [linear,  setLinear]  = useState(DEFAULT_LINEAR);
  const [angular, setAngular] = useState(DEFAULT_ANGULAR);

  const { publishStatus, activeKeys, startKey, stopKey } = useKeyboardTeleop({
    topic,
    msgType,
    linearSpeed:  linear,
    angularSpeed: angular,
    enabled:      isActive,
  });

  function handleTopicChange(t: string, mt: string) {
    setTopic(t);
    setMsgType(mt);
  }

  // ── Touch / mouse button handlers ─────────────────────────────────────────

  function makeBtnHandlers(key: TeleopKey) {
    return {
      onMouseDown:  (e: React.MouseEvent)  => { e.preventDefault(); startKey(key); },
      onMouseUp:    ()                      => stopKey(key),
      onMouseLeave: ()                      => stopKey(key),
      onTouchStart: (e: React.TouchEvent)  => { e.preventDefault(); startKey(key); },
      onTouchEnd:   ()                      => stopKey(key),
    };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="teleop-tab">

      {/* ── Settings panel ─────────────────────────────────────────────── */}
      <section className="teleop-settings card">
        <TopicField onTopicChange={handleTopicChange} />

        <div className="speed-controls">
          <div className="speed-control">
            <label htmlFor="linear-speed">
              Linear speed
              <span className="speed-control__value">{linear.toFixed(2)} m/s</span>
            </label>
            <input
              id="linear-speed"
              type="range"
              min={0.05} max={1.0} step={0.05}
              value={linear}
              onChange={(e) => setLinear(parseFloat(e.target.value))}
              className="speed-control__slider"
            />
          </div>

          <div className="speed-control">
            <label htmlFor="angular-speed">
              Angular speed
              <span className="speed-control__value">{angular.toFixed(2)} rad/s</span>
            </label>
            <input
              id="angular-speed"
              type="range"
              min={0.1} max={2.0} step={0.1}
              value={angular}
              onChange={(e) => setAngular(parseFloat(e.target.value))}
              className="speed-control__slider"
            />
          </div>
        </div>
      </section>

      {/* ── D-pad ─────────────────────────────────────────────────────── */}
      <section className="teleop-dpad card">
        <h2 className="card__title">Controls</h2>
        <p className="teleop-dpad__hint">
          Use <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> on your keyboard, or click/tap the buttons below.
          Press <kbd>X</kbd> for an immediate stop.
        </p>

        <div className="dpad-grid">
          {DPAD_BUTTONS.map((btn) => (
            <button
              key={btn.key}
              id={`dpad-${btn.key}`}
              style={{ gridArea: btn.gridArea }}
              className={[
                "dpad-btn",
                btn.isStop    ? "dpad-btn--stop"   : "",
                !btn.isStop && activeKeys.has(btn.key) ? "dpad-btn--active" : "",
              ].join(" ")}
              aria-label={btn.label}
              aria-pressed={activeKeys.has(btn.key)}
              {...makeBtnHandlers(btn.key)}
            >
              <span className="dpad-btn__icon">{btn.icon}</span>
              <span className="dpad-btn__key">{btn.key.toUpperCase()}</span>
            </button>
          ))}
        </div>

      </section>

      {/* ── Status readout ────────────────────────────────────────────── */}
      <section className="teleop-status card">
        <h2 className="card__title">Publish Status</h2>

        {publishStatus.lastTopic === null ? (
          <p className="status-idle">No commands sent yet. Move the robot to start.</p>
        ) : (
          <dl className="status-dl">
            <div className="status-row">
              <dt>Last topic</dt>
              <dd className="mono">{publishStatus.lastTopic}</dd>
            </div>
            <div className="status-row">
              <dt>Last publish</dt>
              <dd className="mono">{publishStatus.lastTimestamp}</dd>
            </div>
            <div className="status-row">
              <dt>Result</dt>
              <dd>
                {publishStatus.lastOk ? (
                  <span className="badge badge--ok">✓ OK</span>
                ) : (
                  <span className="badge badge--err">✗ Error — {publishStatus.lastError}</span>
                )}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}
