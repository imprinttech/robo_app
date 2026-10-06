"""
routers/docking.py — FastAPI router for ArUco docking actions.

WHY NOT THROUGH ZENOH:
  Same fundamental issues as routers/nav.py — the Zenoh actions bridge can't
  reliably decode send_goal responses or stream feedback. This router uses
  native rclpy.action.ActionClient via ros_docking_client.py, which shares
  the same singleton node created by ros_action_client._get_or_create_node().

Endpoints:
  POST /api/dock
      Send a DockRobot action goal via rclpy.
      Returns {"ok": bool, "goal_id": str}.
      Returns HTTP 409 if a dock/undock operation is already in progress
      (the docking controller's busy_lock would reject it anyway, but we
      surface the error before the ROS round-trip for a cleaner UX).

  POST /api/undock
      Same shape, calls UndockRobot.
      Also returns HTTP 409 if busy.

  GET /api/dock/status
      Return the cached docking status from ros_docking_client (no ROS poll
      per request).
      {"active": bool, "action": str | null, "status": str, "phase": str,
       "battery_percentage": float, "goal_id": str}
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import ros_docking_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["docking"])


# ── Response models ────────────────────────────────────────────────────────────

class DockResponse(BaseModel):
    ok: bool
    goal_id: str


class DockStatusResponse(BaseModel):
    active: bool
    action: str | None          # "dock" | "undock" | None
    status: str                 # ACCEPTED | EXECUTING | SUCCEEDED | CANCELED | ABORTED | UNKNOWN
    phase: str
    battery_percentage: float
    goal_id: str


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.post("/dock", response_model=DockResponse)
async def dock_robot() -> DockResponse:
    """
    Send a DockRobot action goal directly via rclpy.

    Returns HTTP 409 if a docking or undocking operation is already active
    (the server's busy_lock would reject it; we surface the conflict early).
    Returns ok=false with HTTP 200 if the action server rejects the goal.
    """
    status = await ros_docking_client.get_docking_status()
    if status["active"]:
        raise HTTPException(
            status_code=409,
            detail=f"Docking controller is busy ({status['action']} in progress). "
                   "Wait for it to finish before sending a new goal.",
        )

    try:
        result = await ros_docking_client.send_dock_goal()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    logger.info(
        "dock_robot: accepted=%s goal_id=%s",
        result["accepted"], result["goal_id"],
    )
    return DockResponse(ok=result["accepted"], goal_id=result["goal_id"])


@router.post("/undock", response_model=DockResponse)
async def undock_robot() -> DockResponse:
    """
    Send an UndockRobot action goal directly via rclpy.

    Returns HTTP 409 if a docking or undocking operation is already active.
    Returns ok=false with HTTP 200 if the action server rejects the goal.
    """
    status = await ros_docking_client.get_docking_status()
    if status["active"]:
        raise HTTPException(
            status_code=409,
            detail=f"Docking controller is busy ({status['action']} in progress). "
                   "Wait for it to finish before sending a new goal.",
        )

    try:
        result = await ros_docking_client.send_undock_goal()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    logger.info(
        "undock_robot: accepted=%s goal_id=%s",
        result["accepted"], result["goal_id"],
    )
    return DockResponse(ok=result["accepted"], goal_id=result["goal_id"])


@router.get("/dock/status", response_model=DockStatusResponse)
async def get_dock_status() -> DockStatusResponse:
    """
    Return the current cached docking status.

    Reads directly from the in-memory cache maintained by ros_docking_client
    (updated by feedback and result callbacks) — no ROS call is made per request.
    """
    s = await ros_docking_client.get_docking_status()
    return DockStatusResponse(
        active=s["active"],
        action=s["action"],
        status=s["status"],
        phase=s["phase"],
        battery_percentage=s["battery_percentage"],
        goal_id=s["goal_id"],
    )
