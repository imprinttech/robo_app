/**
 * MapCanvas.tsx — Interactive occupancy-grid map with robot pose & RViz-style goal pose.
 *
 * Features:
 *   1. Robot Pose with Clear Heading Arrow:
 *      - Renders robot chassis with glowing accent rim.
 *      - Draws a prominent, forward-facing directional arrow in the heading direction (yaw_deg).
 *      - Informative label showing world coordinates and heading angle.
 *
 *   2. RViz-style Click-and-Drag Goal Pose:
 *      - Left-click mousedown sets goal position (X, Y).
 *      - Dragging draws an interactive arrow in real-time towards the cursor, orienting the heading.
 *      - Mouseup finalizes the goal position and orientation.
 *
 *   3. Independent Map Zoom & Pan:
 *      - Mouse wheel smoothly zooms in/out centered at cursor position.
 *      - Right-click drag or Middle-click drag pans the map around.
 *      - Floating toolbar with Zoom In, Zoom Out, Reset (Fit), and Goal vs Pan mode toggles.
 *      - Confined entirely to the map panel — page layout remains stable.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { MapData, RobotPose } from "../lib/mapApi";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GoalPose {
  x: number;
  y: number;
  yaw_deg: number;
}

interface Props {
  mapData: MapData | null;
  robotPose: RobotPose | null;
  goalPose: GoalPose | null;
  onGoalSet: (pose: GoalPose) => void;
  onGoalPreview?: (pose: GoalPose) => void;
  loading?: boolean;
  error?: string | null;
}

interface DragState {
  isDragging: boolean;
  startScreen: [number, number];
  startWorld: [number, number];
  curScreen: [number, number];
  curWorld: [number, number];
  yawDeg: number;
}

interface PanState {
  isPanning: boolean;
  startX: number;
  startY: number;
  initX: number;
  initY: number;
}

interface RotateState {
  isRotating: boolean;
  startAngle: number;    // angle (rad) from canvas centre to pointer at drag start
  startRotation: number; // mapRotation value at drag start (degrees)
}

// ── Occupancy Grid Colors ─────────────────────────────────────────────────────
const COLOR_OCC = [248, 81, 73]; // Occupied RGB

// ── Canvas Helper: Rounded Rectangle ──────────────────────────────────────────
function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Component ─────────────────────────────────────────────────────────────────

export const MapCanvas: React.FC<Props> = ({
  mapData,
  robotPose,
  goalPose,
  onGoalSet,
  onGoalPreview,
  loading = false,
  error = null,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const mapDrawnRef = useRef(false);

  // View camera state (confined strictly to map alone)
  const [zoom, setZoom] = useState<number>(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [mapRotation, setMapRotation] = useState<number>(0); // degrees CCW
  const [mode, setMode] = useState<"goal" | "pan" | "rotate">("goal");
  const [isPanningUI, setIsPanningUI] = useState(false);
  const [isRotatingUI, setIsRotatingUI] = useState(false);

  // Live drag state for RViz-style goal arrow placement
  const [dragState, setDragState] = useState<DragState | null>(null);

  // Resize observer state to redraw on container dimensions change / mobile rotation
  const [, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Mutable refs for tracking active drag, pan, and rotate operations
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<PanState>({
    isPanning: false,
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });
  const rotateRef = useRef<RotateState>({
    isRotating: false,
    startAngle: 0,
    startRotation: 0,
  });

  // Active pointers map for mobile multi-touch (pinch-to-zoom & two-finger pan)
  const activePointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map());
  const pinchStateRef = useRef<{
    startDist: number;
    startZoom: number;
    startMidWorld: [number, number];
  } | null>(null);

  // ── Render Static Map to Offscreen Canvas ──────────────────────────────────
  const renderMapOffscreen = useCallback((map: MapData) => {
    const offscreen = document.createElement("canvas");
    offscreen.width = map.width;
    offscreen.height = map.height;
    const ctx = offscreen.getContext("2d")!;
    const imageData = ctx.createImageData(map.width, map.height);
    const pixels = imageData.data;

    for (let row = 0; row < map.height; row++) {
      // ROS row 0 = bottom; canvas row 0 = top -> flip vertically
      const rosRow = map.height - 1 - row;
      for (let col = 0; col < map.width; col++) {
        const idx = rosRow * map.width + col;
        const val = map.data[idx];
        const pixIdx = (row * map.width + col) * 4;

        if (val < 0) {
          // Unknown space: dark slate/blue-gray
          pixels[pixIdx] = 0x16;
          pixels[pixIdx + 1] = 0x1f;
          pixels[pixIdx + 2] = 0x2c;
          pixels[pixIdx + 3] = 255;
        } else if (val === 0) {
          // Free space: dark background
          pixels[pixIdx] = 0x09;
          pixels[pixIdx + 1] = 0x0d;
          pixels[pixIdx + 2] = 0x13;
          pixels[pixIdx + 3] = 255;
        } else {
          // Occupied obstacle: vibrant red gradient
          const t = Math.min(1.0, val / 100);
          pixels[pixIdx] = Math.round(COLOR_OCC[0] * t + 0x3a * (1 - t));
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

  // Invalidate offscreen cache when mapData changes
  useEffect(() => {
    mapDrawnRef.current = false;
    offscreenRef.current = null;
  }, [mapData]);

  // ── Viewport Geometry & Coordinate Transformations ──────────────────────────
  const getViewportMetrics = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapData) {
      return { cssWidth: 600, cssHeight: 500, fitScale: 1, cellScale: 1, viewX: 0, viewY: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(100, rect.width);
    const cssHeight = Math.max(100, rect.height);

    const fitScale = Math.min(cssWidth / mapData.width, cssHeight / mapData.height) * 0.94;
    const cellScale = fitScale * zoom;

    const mapPixelW = mapData.width * cellScale;
    const mapPixelH = mapData.height * cellScale;
    const baseOffsetX = (cssWidth - mapPixelW) / 2;
    const baseOffsetY = (cssHeight - mapPixelH) / 2;

    const viewX = baseOffsetX + panOffset.x;
    const viewY = baseOffsetY + panOffset.y;

    return { cssWidth, cssHeight, fitScale, cellScale, viewX, viewY };
  }, [mapData, zoom, panOffset]);

  // Rotate a canvas-space point around the canvas centre by -mapRotation
  // (un-rotates the rotated canvas coordinate back to the unrotated map space)
  const unrotateScreenPoint = useCallback(
    (sx: number, sy: number): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [sx, sy];
      const rect = canvas.getBoundingClientRect();
      const cx = Math.max(100, rect.width) / 2;
      const cy = Math.max(100, rect.height) / 2;
      const rad = -(mapRotation * Math.PI) / 180;
      const dx = sx - cx;
      const dy = sy - cy;
      return [
        cx + dx * Math.cos(rad) - dy * Math.sin(rad),
        cy + dx * Math.sin(rad) + dy * Math.cos(rad),
      ];
    },
    [mapRotation]
  );

  // Rotate an unrotated canvas-space point into the rotated frame
  const rotateScreenPoint = useCallback(
    (sx: number, sy: number): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [sx, sy];
      const rect = canvas.getBoundingClientRect();
      const cx = Math.max(100, rect.width) / 2;
      const cy = Math.max(100, rect.height) / 2;
      const rad = (mapRotation * Math.PI) / 180;
      const dx = sx - cx;
      const dy = sy - cy;
      return [
        cx + dx * Math.cos(rad) - dy * Math.sin(rad),
        cy + dx * Math.sin(rad) + dy * Math.cos(rad),
      ];
    },
    [mapRotation]
  );

  const screenToWorld = useCallback(
    (sx: number, sy: number): [number, number] => {
      if (!mapData) return [0, 0];
      // Un-rotate the screen point into the unrotated map frame first
      const [ux, uy] = unrotateScreenPoint(sx, sy);
      const { cellScale, viewX, viewY } = getViewportMetrics();
      const cellX = (ux - viewX) / cellScale;
      const cellY = mapData.height - (uy - viewY) / cellScale;
      const wx = cellX * mapData.resolution + mapData.origin_x;
      const wy = cellY * mapData.resolution + mapData.origin_y;
      return [wx, wy];
    },
    [mapData, getViewportMetrics, unrotateScreenPoint]
  );

  const worldToScreen = useCallback(
    (wx: number, wy: number): [number, number] => {
      if (!mapData) return [0, 0];
      const { cellScale, viewX, viewY } = getViewportMetrics();
      const cellX = (wx - mapData.origin_x) / mapData.resolution;
      const cellY = (wy - mapData.origin_y) / mapData.resolution;
      // Unrotated canvas position
      const ux = viewX + cellX * cellScale;
      const uy = viewY + (mapData.height - cellY) * cellScale;
      // Rotate into current map rotation frame
      return rotateScreenPoint(ux, uy);
    },
    [mapData, getViewportMetrics, rotateScreenPoint]
  );

  // ── Render Frame ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!mapDrawnRef.current) {
      renderMapOffscreen(mapData);
    }

    const { cssWidth, cssHeight, cellScale, viewX, viewY } = getViewportMetrics();

    // High-DPI support for razor-sharp vector rendering
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Clear background
    ctx.fillStyle = "#0a0e14";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // 2. Apply map rotation around canvas centre
    const rotRad = (mapRotation * Math.PI) / 180;
    ctx.save();
    ctx.translate(cssWidth / 2, cssHeight / 2);
    ctx.rotate(rotRad);
    ctx.translate(-cssWidth / 2, -cssHeight / 2);

    // 3. Draw offscreen occupancy map
    if (offscreenRef.current) {
      ctx.imageSmoothingEnabled = false; // Preserve crisp grid cells
      ctx.drawImage(
        offscreenRef.current,
        0,
        0,
        mapData.width,
        mapData.height,
        viewX,
        viewY,
        mapData.width * cellScale,
        mapData.height * cellScale
      );
    }

    // 4. Draw map boundary border
    ctx.strokeStyle = "rgba(88, 166, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(viewX, viewY, mapData.width * cellScale, mapData.height * cellScale);

    // 5. Subtle distance grid overlay when zoomed in
    if (cellScale >= 3.5) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 0.5;
      const step = cellScale * Math.max(1, Math.round(1.0 / mapData.resolution)); // ~1 meter grid
      const startX = viewX % step;
      const startY = viewY % step;
      for (let x = startX; x < cssWidth; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssHeight);
        ctx.stroke();
      }
      for (let y = startY; y < cssHeight; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssWidth, y);
        ctx.stroke();
      }
    }

    ctx.restore(); // Undo map rotation — restore context to physical screen space

    // 6. Draw Placed Goal Pose (if set)
    if (goalPose && !dragState?.isDragging) {
      const [gx, gy] = worldToScreen(goalPose.x, goalPose.y);
      drawNavGoalMarker(ctx, gx, gy, goalPose.yaw_deg - mapRotation, false);
      drawSimpleLabel(ctx, gx, gy, "Goal", "#f0a500");
    }

    // 7. Draw Robot Pose with prominent directional arrow
    if (robotPose) {
      const [rx, ry] = worldToScreen(robotPose.x, robotPose.y);
      drawRobotMarker(ctx, rx, ry, robotPose.yaw_deg - mapRotation);
      drawSimpleLabel(ctx, rx, ry, "Robot", "#58a6ff");
    }

    // 8. Draw RViz-style Click-and-Drag Live Goal Arrow
    if (dragState?.isDragging) {
      const [sx, sy] = dragState.startScreen;
      const [cx, cy] = dragState.curScreen;
      const dragDist = Math.hypot(cx - sx, cy - sy);
      const arrowLen = Math.max(28, dragDist);

      drawNavGoalMarker(ctx, sx, sy, dragState.yawDeg - mapRotation, true, arrowLen);

      // HUD readout badge next to the cursor (always upright and readable)
      const hudText = `🎯 Goal: (${dragState.startWorld[0].toFixed(2)}, ${dragState.startWorld[1].toFixed(2)})  Heading: ${dragState.yawDeg.toFixed(1)}°`;
      drawHUDTag(ctx, cx + 16, cy - 12, hudText);
    }

    // 9. Draw rotation badge overlay (top-right, always upright)
    if (mapRotation !== 0) {
      const badgeText = `↻ ${((mapRotation % 360) + 360) % 360}°`;
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(badgeText).width;
      const bw = tw + 14;
      const bh = 22;
      const bx = cssWidth - bw - 10;
      const by = 10;
      ctx.fillStyle = "rgba(22, 27, 34, 0.88)";
      ctx.strokeStyle = "rgba(88, 166, 255, 0.6)";
      ctx.lineWidth = 1;
      drawRoundRect(ctx, bx, by, bw, bh, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#79c0ff";
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(badgeText, bx + bw / 2, by + bh / 2);
    }
  }, [mapData, robotPose, goalPose, dragState, zoom, panOffset, mapRotation, getViewportMetrics, renderMapOffscreen, worldToScreen]);

  // ── Marker Drawing Helpers ──────────────────────────────────────────────────

  /**
   * Draw Robot Chassis and forward-facing heading arrow.
   */
  function drawRobotMarker(ctx: CanvasRenderingContext2D, rx: number, ry: number, yawDeg: number) {
    const yawRad = (yawDeg * Math.PI) / 180;

    ctx.save();
    ctx.translate(rx, ry);

    const baseRadius = 9; // Compact chassis circle

    // 1. Robot chassis base circle
    ctx.shadowColor = "rgba(88, 166, 255, 0.6)";
    ctx.shadowBlur = 8;

    ctx.beginPath();
    ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#111b27";
    ctx.fill();
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // Inner concentric ring
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(88, 166, 255, 0.4)";
    ctx.lineWidth = 1.0;
    ctx.stroke();

    // Center pivot dot
    ctx.beginPath();
    ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // 2. Forward-Facing Arrow
    // Note: Canvas Y is flipped downwards, so we rotate by -yawRad
    ctx.rotate(-yawRad);

    const arrowTotalLength = 21;
    const headLength = 8.5;
    const headWidth = 8;

    // Arrow shaft with cyan glow
    ctx.shadowColor = "#58a6ff";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(baseRadius * 0.35, 0);
    ctx.lineTo(arrowTotalLength - headLength + 2, 0);
    ctx.strokeStyle = "#79c0ff";
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.stroke();

    // Directional Arrowhead
    ctx.beginPath();
    ctx.moveTo(arrowTotalLength, 0); // Tip
    ctx.lineTo(arrowTotalLength - headLength, -headWidth / 2);
    ctx.lineTo(arrowTotalLength - headLength + 2, 0);
    ctx.lineTo(arrowTotalLength - headLength, headWidth / 2);
    ctx.closePath();
    ctx.fillStyle = "#58a6ff";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.0;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Draw RViz-style Navigation Goal Marker & Heading Arrow.
   */
  function drawNavGoalMarker(
    ctx: CanvasRenderingContext2D,
    gx: number,
    gy: number,
    yawDeg: number,
    isLiveDrag: boolean,
    arrowLength = 28
  ) {
    const yawRad = (yawDeg * Math.PI) / 180;
    const color = isLiveDrag ? "#f0a500" : "#e39800";
    const glow = isLiveDrag ? "rgba(240, 165, 0, 0.8)" : "rgba(240, 165, 0, 0.45)";

    ctx.save();
    ctx.translate(gx, gy);

    // 1. Goal base target ring (compact)
    ctx.shadowColor = glow;
    ctx.shadowBlur = isLiveDrag ? 12 : 8;

    ctx.beginPath();
    ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(240, 165, 0, 0.2)";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Center pivot
    ctx.beginPath();
    ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // 2. Goal Heading Arrow
    ctx.rotate(-yawRad);

    const headLen = 9.5;
    const headW = 8.5;

    // Arrow shaft
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(arrowLength - headLen + 2, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.8;
    ctx.lineCap = "round";
    ctx.stroke();

    // Arrow head
    ctx.beginPath();
    ctx.moveTo(arrowLength, 0);
    ctx.lineTo(arrowLength - headLen, -headW / 2);
    ctx.lineTo(arrowLength - headLen + 2, 0);
    ctx.lineTo(arrowLength - headLen, headW / 2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.0;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Minimal clean label badge above robot or goal ("Robot", "Goal").
   */
  function drawSimpleLabel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    accentColor: string
  ) {
    ctx.save();
    ctx.font = "bold 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    const textWidth = ctx.measureText(text).width;
    const h = 17;
    const w = textWidth + 12;
    const bx = x - w / 2;
    const by = y - 22;

    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(13, 17, 23, 0.88)";
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1;
    drawRoundRect(ctx, bx, by, w, h, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accentColor;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(text, x, by + h / 2 + 0.5);
    ctx.restore();
  }

  /**
   * HUD readout tag during interactive drag.
   */
  function drawHUDTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
    ctx.font = "bold 11px sans-serif";
    const tw = ctx.measureText(text).width;
    const h = 24;
    const w = tw + 16;

    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 10;

    ctx.fillStyle = "rgba(22, 27, 34, 0.94)";
    ctx.strokeStyle = "#f0a500";
    ctx.lineWidth = 1.5;
    drawRoundRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, x + 8, y + h / 2);
  }

  // ── Mouse & Pointer Event Handlers ──────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!mapData) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    activePointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Multi-touch: 2 or more fingers -> Enter pinch-to-zoom and two-finger pan mode
    if (activePointersRef.current.size >= 2) {
      if (dragRef.current) {
        dragRef.current.isDragging = false;
        setDragState(null);
      }
      if (panRef.current.isPanning) {
        panRef.current.isPanning = false;
        setIsPanningUI(false);
      }

      const pts = Array.from(activePointersRef.current.values());
      const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      const midClientX = (pts[0].clientX + pts[1].clientX) / 2;
      const midClientY = (pts[0].clientY + pts[1].clientY) / 2;

      const rect = canvas.getBoundingClientRect();
      const midX = midClientX - rect.left;
      const midY = midClientY - rect.top;
      const midWorld = screenToWorld(midX, midY);

      pinchStateRef.current = {
        startDist: Math.max(10, dist),
        startZoom: zoom,
        startMidWorld: midWorld,
      };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Right-click (button 2), Middle-click (button 1), or Pan mode with Left-click / Touch
    if (e.button === 2 || e.button === 1 || (e.button === 0 && mode === "pan")) {
      panRef.current = {
        isPanning: true,
        startX: e.clientX,
        startY: e.clientY,
        initX: panOffset.x,
        initY: panOffset.y,
      };
      setIsPanningUI(true);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    // Left-click / Touch in Rotate Mode -> Free-spin the map
    if (e.button === 0 && mode === "rotate") {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const dx = (e.clientX - rect.left) - cx;
      const dy = (e.clientY - rect.top) - cy;
      rotateRef.current = {
        isRotating: true,
        startAngle: Math.atan2(dy, dx),
        startRotation: mapRotation,
      };
      setIsRotatingUI(true);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }

    // Left-click / Touch in Goal Mode -> Start RViz-style Goal Pose Drag
    if (e.button === 0 && mode === "goal") {
      const [wx, wy] = screenToWorld(mouseX, mouseY);
      const newDrag: DragState = {
        isDragging: true,
        startScreen: [mouseX, mouseY],
        startWorld: [wx, wy],
        curScreen: [mouseX, mouseY],
        curWorld: [wx, wy],
        yawDeg: 0,
      };
      dragRef.current = newDrag;
      setDragState(newDrag);
      if (onGoalPreview) {
        onGoalPreview({ x: wx, y: wy, yaw_deg: 0 });
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !mapData) return;

    activePointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

    // Handle Active Two-Finger Pinch Zoom & Pan
    if (activePointersRef.current.size >= 2 && pinchStateRef.current) {
      const pts = Array.from(activePointersRef.current.values());
      const curDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      const curMidClientX = (pts[0].clientX + pts[1].clientX) / 2;
      const curMidClientY = (pts[0].clientY + pts[1].clientY) / 2;

      const rect = canvas.getBoundingClientRect();
      const curMidX = curMidClientX - rect.left;
      const curMidY = curMidClientY - rect.top;

      const scaleFactor = curDist / pinchStateRef.current.startDist;
      const newZoom = Math.min(10.0, Math.max(0.4, pinchStateRef.current.startZoom * scaleFactor));

      const { cssWidth, cssHeight, fitScale } = getViewportMetrics();
      const newCellScale = fitScale * newZoom;
      const newBaseX = (cssWidth - mapData.width * newCellScale) / 2;
      const newBaseY = (cssHeight - mapData.height * newCellScale) / 2;

      const [wx, wy] = pinchStateRef.current.startMidWorld;
      const cellX = (wx - mapData.origin_x) / mapData.resolution;
      const cellY = (wy - mapData.origin_y) / mapData.resolution;
      const rosPxNew = cellX * newCellScale;
      const rosPyNew = (mapData.height - cellY) * newCellScale;

      const [uMidX, uMidY] = unrotateScreenPoint(curMidX, curMidY);
      const newPanX = uMidX - newBaseX - rosPxNew;
      const newPanY = uMidY - newBaseY - rosPyNew;

      setZoom(newZoom);
      setPanOffset({ x: newPanX, y: newPanY });
      return;
    }

    // Handle Active Pan
    if (panRef.current.isPanning) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      const rad = -(mapRotation * Math.PI) / 180;
      const unrotDx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const unrotDy = dx * Math.sin(rad) + dy * Math.cos(rad);
      setPanOffset({
        x: panRef.current.initX + unrotDx,
        y: panRef.current.initY + unrotDy,
      });
      return;
    }

    // Handle Active Free-Rotate
    if (rotateRef.current.isRotating) {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const dx = (e.clientX - rect.left) - cx;
      const dy = (e.clientY - rect.top) - cy;
      const curAngle = Math.atan2(dy, dx);
      const deltaRad = curAngle - rotateRef.current.startAngle;
      const deltaDeg = (deltaRad * 180) / Math.PI;
      setMapRotation(rotateRef.current.startRotation + deltaDeg);
      return;
    }

    // Handle Active Goal Drag
    if (dragRef.current?.isDragging) {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const [curWx, curWy] = screenToWorld(mouseX, mouseY);

      // Calculate heading angle in map world coordinates
      const dxWorld = curWx - dragRef.current.startWorld[0];
      const dyWorld = curWy - dragRef.current.startWorld[1];
      const distWorld = Math.hypot(dxWorld, dyWorld);

      let yawDeg = dragRef.current.yawDeg;
      if (distWorld > 0.04) {
        yawDeg = (Math.atan2(dyWorld, dxWorld) * 180) / Math.PI;
      }

      const updatedDrag: DragState = {
        ...dragRef.current,
        curScreen: [mouseX, mouseY],
        curWorld: [curWx, curWy],
        yawDeg,
      };
      dragRef.current = updatedDrag;
      setDragState(updatedDrag);

      if (onGoalPreview) {
        onGoalPreview({
          x: updatedDrag.startWorld[0],
          y: updatedDrag.startWorld[1],
          yaw_deg: yawDeg,
        });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStateRef.current = null;
    }

    // Finish Pan
    if (panRef.current.isPanning) {
      panRef.current.isPanning = false;
      setIsPanningUI(false);
    }

    // Finish Rotate
    if (rotateRef.current.isRotating) {
      rotateRef.current.isRotating = false;
      setIsRotatingUI(false);
    }

    // Finish Goal Placement (RViz Style) → auto-switch back to Pan
    if (dragRef.current?.isDragging) {
      const finalized = { ...dragRef.current };
      dragRef.current.isDragging = false;
      setDragState(null);

      onGoalSet({
        x: finalized.startWorld[0],
        y: finalized.startWorld[1],
        yaw_deg: finalized.yawDeg,
      });

      // Automatically revert to Pan mode so the user must
      // explicitly press Goal again before placing the next goal.
      setMode("pan");
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault(); // Prevent default browser context menu for right-drag pan
  };

  // ── Wheel Zoom Centered at Mouse Cursor (User Requirement 3) ────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapData) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // Stop page scrolling entirely when zooming the map

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // 1. World coordinates before zoom
      const [wx, wy] = screenToWorld(mouseX, mouseY);

      // 2. Calculate new zoom level
      const factor = e.deltaY < 0 ? 1.16 : 1 / 1.16;
      const newZoom = Math.min(10.0, Math.max(0.4, zoom * factor));
      if (Math.abs(newZoom - zoom) < 0.001) return;

      // 3. Adjust pan offset so (wx, wy) remains stationary under cursor
      const { cssWidth, cssHeight, fitScale } = getViewportMetrics();
      const newCellScale = fitScale * newZoom;
      const newMapW = mapData.width * newCellScale;
      const newMapH = mapData.height * newCellScale;
      const newBaseX = (cssWidth - newMapW) / 2;
      const newBaseY = (cssHeight - newMapH) / 2;

      const cellX = (wx - mapData.origin_x) / mapData.resolution;
      const cellY = (wy - mapData.origin_y) / mapData.resolution;
      const rosPxNew = cellX * newCellScale;
      const rosPyNew = (mapData.height - cellY) * newCellScale;

      const [uMouseX, uMouseY] = unrotateScreenPoint(mouseX, mouseY);
      const newPanX = uMouseX - newBaseX - rosPxNew;
      const newPanY = uMouseY - newBaseY - rosPyNew;

      setZoom(newZoom);
      setPanOffset({ x: newPanX, y: newPanY });
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [mapData, zoom, panOffset, screenToWorld, getViewportMetrics, unrotateScreenPoint]);

  // ── Zoom & Rotate Toolbar Controls ─────────────────────────────────────────
  const handleZoomIn = () => {
    setZoom((z) => Math.min(10.0, z * 1.25));
  };

  const handleZoomOut = () => {
    setZoom((z) => Math.max(0.4, z / 1.25));
  };

  const handleResetView = () => {
    setZoom(1.0);
    setPanOffset({ x: 0, y: 0 });
    setMapRotation(0);
  };


  // ── Loading & Error States ──────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="map-canvas-placeholder map-canvas-placeholder--loading">
        <div className="map-canvas-spinner" />
        <p>Fetching occupancy map from /map_server/map…</p>
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

  // ── Cursor Class Calculation ────────────────────────────────────────────────
  let cursorClass = "map-canvas--cursor-goal";
  if (isRotatingUI) {
    cursorClass = "map-canvas--cursor-grabbing";
  } else if (isPanningUI) {
    cursorClass = "map-canvas--cursor-grabbing";
  } else if (mode === "pan") {
    cursorClass = "map-canvas--cursor-grab";
  } else if (mode === "rotate") {
    cursorClass = "map-canvas--cursor-grab";
  } else if (dragState?.isDragging) {
    cursorClass = "map-canvas--cursor-dragging";
  }

  return (
    <div className="map-canvas-wrapper" ref={containerRef}>
      {/* ── Map Canvas Element ─────────────────────────────────────────── */}
      <canvas
        ref={canvasRef}
        id="map-canvas"
        className={`map-canvas ${cursorClass}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={handleContextMenu}
        aria-label="Occupancy grid map — drag to set goal and heading like RViz"
      />

      {/* ── Independent Map Zoom & Pan Toolbar (Requirement 3) ──────────── */}
      <div className="map-toolbar">
        <div className="map-toolbar__group">
          <button
            type="button"
            className={`map-toolbar__btn ${mode === "goal" ? "map-toolbar__btn--active" : ""}`}
            onClick={() => setMode("goal")}
            title="Goal Mode: Click and drag arrow to set target and heading (RViz style)"
          >
            🎯 Goal
          </button>
          <button
            type="button"
            className={`map-toolbar__btn ${mode === "pan" ? "map-toolbar__btn--active" : ""}`}
            onClick={() => setMode("pan")}
            title="Pan Mode: Left-drag or single-touch to pan the map"
          >
            ✋ Pan
          </button>
          <button
            type="button"
            className={`map-toolbar__btn ${mode === "rotate" ? "map-toolbar__btn--active" : ""}`}
            onClick={() => setMode("rotate")}
            title="Rotate Mode: Drag anywhere on the map to freely spin it in any direction"
          >
            ↻ Rotate
          </button>
        </div>

        <div className="map-toolbar__group">
          <button
            type="button"
            className="map-toolbar__btn"
            onClick={handleZoomIn}
            title="Zoom In"
            aria-label="Zoom in"
          >
            ＋
          </button>
          <button
            type="button"
            className="map-toolbar__btn map-toolbar__btn--label"
            onClick={handleResetView}
            title="Click to reset zoom to 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="map-toolbar__btn"
            onClick={handleZoomOut}
            title="Zoom Out"
            aria-label="Zoom out"
          >
            －
          </button>
          <button
            type="button"
            className="map-toolbar__btn"
            onClick={handleResetView}
            title="Fit to view / Reset pan & rotation"
          >
            ⟲ Fit
          </button>
        </div>

        <div className="map-toolbar__group">
          <button
            type="button"
            className="map-toolbar__btn map-toolbar__btn--label"
            onClick={() => setMapRotation(0)}
            title="Current rotation — click to reset to 0°"
            aria-label="Reset map rotation"
            style={{ minWidth: 44 }}
          >
            {Math.round(((mapRotation % 360) + 360) % 360)}°
          </button>
        </div>
      </div>

      {/* ── Map Interactive Guide Footer ────────────────────────────────── */}
      <div className="map-footer-hint">
        <span className="map-footer-hint__desktop">
          🎯 <strong>Left-drag</strong>: Goal & Heading · ✋ <strong>Right-drag</strong>: Pan · 🔍 <strong>Scroll</strong>: Zoom · ↺↻ <strong>Rotate</strong>: map orientation
        </span>
        <span className="map-footer-hint__mobile">
          🎯 <strong>Goal</strong>: Drag arrow · ✋ <strong>Pan</strong> · 🔍 Pinch zoom · ↺↻ Rotate
        </span>
      </div>
    </div>
  );
};
