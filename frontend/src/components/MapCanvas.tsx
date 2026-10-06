/**
 * MapCanvas.tsx — Interactive occupancy-grid map with robot pose overlay.
 *
 * Props:
 *   mapData   — OccupancyGrid description fetched from /api/map
 *   robotPose — Current robot pose (x, y, yaw_deg) in map frame, or null
 *   goalPose  — Pending goal pose (x, y, yaw_deg) in map frame, or null
 *   onGoalSet — Called when the user clicks the map to place a new goal
 *   loading   — Show loading skeleton
 *   error     — Show error message instead of canvas
 *
 * Coordinate conventions:
 *   ROS OccupancyGrid:  row 0 = bottom of map (smallest Y)
 *   Canvas:             row 0 = top of screen
 *   → We flip vertically when drawing: canvasRow = (height - 1 - rosRow)
 *
 * Cell value colours:
 *   -1 (unknown) → #1e2a3a  (dark blue-grey)
 *    0 (free)    → #0d1117  (near-black, slightly lighter)
 *  1–100 (occ)  → interpolated #f85149 → #ff6e6e (red gradient by probability)
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { MapData, RobotPose } from "../lib/mapApi";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GoalPose {
  x: number;
  y: number;
  yaw_deg: number;
}

interface Props {
  mapData: MapData | null;
  robotPose: RobotPose | null;
  goalPose: GoalPose | null;
  onGoalSet: (pose: GoalPose) => void;
  loading?: boolean;
  error?: string | null;
}

// ── Colour palette ────────────────────────────────────────────────────────────
const COLOR_UNKNOWN = "#1e2a3a";
const COLOR_FREE = "#0d1117";
const COLOR_OCC = [248, 81, 73];   // RGB for fully occupied

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert map-frame world coords → canvas pixel coords. */
function worldToCanvas(
  worldX: number, worldY: number,
  map: MapData, scale: number
): [number, number] {
  const cellX = (worldX - map.origin_x) / map.resolution;
  const cellY = (worldY - map.origin_y) / map.resolution;
  // Flip Y: ROS row 0 is bottom, canvas row 0 is top
  const px = cellX * scale;
  const py = (map.height - cellY) * scale;
  return [px, py];
}

/** Convert canvas pixel coords → map-frame world coords. */
function canvasToWorld(
  px: number, py: number,
  map: MapData, scale: number,
  rect: DOMRect
): [number, number] {
  const cellX = (px - rect.left) / scale;
  const cellY = map.height - (py - rect.top) / scale;
  const worldX = cellX * map.resolution + map.origin_x;
  const worldY = cellY * map.resolution + map.origin_y;
  return [worldX, worldY];
}

/** Draw an arrow (robot or goal marker) on the canvas. */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  yawDeg: number,
  radius: number,
  color: string,
  glowColor: string
) {
  const angle = (yawDeg * Math.PI) / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-angle); // canvas Y is flipped

  // Glow
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 12;

  // Circle body
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#ffffff44";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Direction arrow
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.moveTo(radius * 0.4, 0);
  ctx.lineTo(-radius * 0.35, radius * 0.35);
  ctx.lineTo(-radius * 0.1, 0);
  ctx.lineTo(-radius * 0.35, -radius * 0.35);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.restore();
}

// ── Component ─────────────────────────────────────────────────────────────────

export const MapCanvas: React.FC<Props> = ({
  mapData, robotPose, goalPose, onGoalSet, loading = false, error = null
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const mapDrawnRef = useRef(false);
  const [scale, setScale] = useState(1);
  const [pendingYaw, setPendingYaw] = useState<{ x: number; y: number } | null>(null);

  // ── Render the static occupancy grid to an offscreen canvas ────────────────
  const renderMapOffscreen = useCallback((map: MapData) => {
    const offscreen = document.createElement("canvas");
    offscreen.width = map.width;
    offscreen.height = map.height;
    const ctx = offscreen.getContext("2d")!;
    const imageData = ctx.createImageData(map.width, map.height);
    const pixels = imageData.data;

    for (let row = 0; row < map.height; row++) {
      // ROS row 0 = bottom; canvas row 0 = top → flip
      const rosRow = map.height - 1 - row;
      for (let col = 0; col < map.width; col++) {
        const idx = rosRow * map.width + col;
        const val = map.data[idx];
        const pixIdx = (row * map.width + col) * 4;
        if (val < 0) {
          // Unknown
          pixels[pixIdx] = 0x1e;
          pixels[pixIdx + 1] = 0x2a;
          pixels[pixIdx + 2] = 0x3a;
          pixels[pixIdx + 3] = 255;
        } else if (val === 0) {
          // Free
          pixels[pixIdx] = 0x0d;
          pixels[pixIdx + 1] = 0x11;
          pixels[pixIdx + 2] = 0x17;
          pixels[pixIdx + 3] = 255;
        } else {
          // Occupied — red, brighter for higher probability
          const t = val / 100;
          pixels[pixIdx] = Math.round(COLOR_OCC[0] * t + 0x2a * (1 - t));
          pixels[pixIdx + 1] = Math.round(COLOR_OCC[1] * t);
          pixels[pixIdx + 2] = Math.round(COLOR_OCC[2] * t);
          pixels[pixIdx + 3] = 255;
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
    offscreenRef.current = offscreen;
    mapDrawnRef.current = true;
  }, []);

  // ── Determine display scale to fit the container ───────────────────────────
  useEffect(() => {
    if (!mapData) return;
    const container = canvasRef.current?.parentElement;
    if (!container) return;
    const maxW = container.clientWidth - 8;
    const maxH = Math.min(container.clientHeight || 480, 520);
    const scaleW = maxW / mapData.width;
    const scaleH = maxH / mapData.height;
    setScale(Math.max(0.5, Math.min(3.0, Math.min(scaleW, scaleH))));
  }, [mapData]);

  // ── Re-render the full canvas on every change ──────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapData) return;
    const ctx = canvas.getContext("2d")!;

    // 1. Draw the offscreen map (lazy — only if not yet rendered)
    if (!mapDrawnRef.current) renderMapOffscreen(mapData);

    canvas.width = mapData.width * scale;
    canvas.height = mapData.height * scale;

    ctx.imageSmoothingEnabled = false;
    if (offscreenRef.current) {
      ctx.drawImage(offscreenRef.current, 0, 0, canvas.width, canvas.height);
    }

    // 2. Draw grid overlay (only when zoomed enough)
    if (scale >= 4) {
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.lineWidth = 0.5;
      for (let c = 0; c <= mapData.width; c++) {
        ctx.beginPath();
        ctx.moveTo(c * scale, 0);
        ctx.lineTo(c * scale, canvas.height);
        ctx.stroke();
      }
      for (let r = 0; r <= mapData.height; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * scale);
        ctx.lineTo(canvas.width, r * scale);
        ctx.stroke();
      }
    }

    // 3. Draw goal pose
    if (goalPose) {
      const [gx, gy] = worldToCanvas(goalPose.x, goalPose.y, mapData, scale);
      drawArrow(ctx, gx, gy, goalPose.yaw_deg, scale * 1.8, "#f0a500bb", "#f0a500");

      // Label
      ctx.font = `${Math.max(9, scale * 1.2)}px monospace`;
      ctx.fillStyle = "#f0a500";
      ctx.fillText(`Goal (${goalPose.x.toFixed(1)}, ${goalPose.y.toFixed(1)})`, gx + scale * 2.5, gy - scale * 2);
    }

    // 4. Draw robot pose
    if (robotPose) {
      const [rx, ry] = worldToCanvas(robotPose.x, robotPose.y, mapData, scale);
      drawArrow(ctx, rx, ry, robotPose.yaw_deg, scale * 2.0, "#58a6ff", "#58a6ff");

      ctx.font = `${Math.max(9, scale * 1.2)}px monospace`;
      ctx.fillStyle = "#58a6ff";
      ctx.fillText("Robot", rx + scale * 2.5, ry + scale * 1.5);
    }

    // 5. Pending click indicator (first click = position, second = direction)
    if (pendingYaw) {
      const [cx, cy] = worldToCanvas(pendingYaw.x, pendingYaw.y, mapData, scale);
      ctx.beginPath();
      ctx.arc(cx, cy, scale * 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = "#f0a500";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `${Math.max(10, scale * 1.3)}px sans-serif`;
      ctx.fillStyle = "#f0a500aa";
      ctx.fillText("Click to set heading →", cx + scale * 2, cy - scale * 2);
    }
  }, [mapData, robotPose, goalPose, scale, pendingYaw, renderMapOffscreen]);

  // Invalidate offscreen when mapData changes
  useEffect(() => {
    mapDrawnRef.current = false;
    offscreenRef.current = null;
  }, [mapData]);

  // ── Click handler: two-click goal placement ────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!mapData) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const [wx, wy] = canvasToWorld(e.clientX, e.clientY, mapData, scale, rect);

      if (!pendingYaw) {
        // First click: set position
        setPendingYaw({ x: wx, y: wy });
      } else {
        // Second click: compute heading from first click to this click
        const dx = wx - pendingYaw.x;
        const dy = wy - pendingYaw.y;
        const yawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
        onGoalSet({ x: pendingYaw.x, y: pendingYaw.y, yaw_deg: yawDeg });
        setPendingYaw(null);
      }
    },
    [mapData, scale, pendingYaw, onGoalSet]
  );

  // Cancel pending goal on right-click / Escape
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPendingYaw(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="map-canvas-placeholder map-canvas-placeholder--loading">
        <div className="map-canvas-spinner" />
        <p>Fetching map from /map_server/map…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="map-canvas-placeholder map-canvas-placeholder--error">
        <span className="map-canvas-placeholder__icon">🗺️</span>
        <p>{error}</p>
        <small>Check that map_server and the Zenoh services bridge (port 8888) are running.</small>
      </div>
    );
  }
  if (!mapData) {
    return (
      <div className="map-canvas-placeholder">
        <span className="map-canvas-placeholder__icon">🗺️</span>
        <p>Map not loaded</p>
      </div>
    );
  }

  return (
    <div className="map-canvas-wrapper" title={pendingYaw ? "Click to set heading" : "Click to place goal"}>
      <canvas
        ref={canvasRef}
        id="map-canvas"
        className={`map-canvas ${pendingYaw ? "map-canvas--set-heading" : "map-canvas--set-goal"}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        aria-label="Occupancy grid map — click to set navigation goal"
      />
      {pendingYaw && (
        <div className="map-canvas-hint">
          📍 Position set — click again to set heading direction
        </div>
      )}
    </div>
  );
};
