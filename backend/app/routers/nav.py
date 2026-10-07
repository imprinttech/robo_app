"""
routers/nav.py — FastAPI router for Nav2 goal-pose navigation.

WHY NOT THROUGH ZENOH:
  This router previously delegated to the Zenoh actions bridge (port 9999), but
  that approach had two unfixable problems:
    1. The bridge's send_goal response never contained a real `accepted` boolean
       — it returned a Zenoh "ERROR" key, making it impossible to confirm
       bt_navigator accepted the goal.
    2. The _action/status and _action/feedback sub-interfaces are routed as plain
       topics by the bridge, not queryables, so polling them always returned []
       — the same root issue already fixed for AMCL pose (pose_cache.py) and map
       service calls (ros_service_caller.py).

  This router now delegates to ros_action_client.py, which uses a native
  rclpy.action.ActionClient — exactly the same pattern as the other two
  subsystems. The frontend API contract (URLs, request/response shapes) is
  unchanged.

Endpoints:
  POST /api/nav/goal
      Send a NavigateToPose goal directly via rclpy.
      Accepts x, y, yaw_deg in the map frame.
      Returns {"ok": <accepted bool>, "goal_id": "<uuid>"}.
      Returns ok=false (HTTP 200) if bt_navigator rejects the goal, so the
      frontend can display "goal rejected" rather than treating it as a network
      error.

  GET /api/nav/goal/status
      Return the cached status from ros_action_client (no ROS poll per request).
      {"active": bool, "goal_id": str, "status": str, "distance_remaining": float}

  DELETE /api/nav/goal
      Cancel the active navigation goal via rclpy.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import ros_action_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/nav", tags=["navigation"])


# ── Request / Response models ──────────────────────────────────────────────────

class GoalRequest(BaseModel):
    x: float
    y: float
    yaw_deg: float = Field(default=0.0, description="Heading in degrees (0 = East)")


class GoalResponse(BaseModel):
    ok: bool
    goal_id: str


class CancelResponse(BaseModel):
    ok: bool
    message: str


class GoalCoords(BaseModel):
    x: float
    y: float
    yaw_deg: float = 0.0


class StatusResponse(BaseModel):
    active: bool
    goal_id: str
    status: str          # "ACCEPTED" | "EXECUTING" | "SUCCEEDED" | "CANCELED" | "UNKNOWN"
    distance_remaining: float = 0.0
    goal: GoalCoords | None = None
    paused: bool = False


class PauseRequest(BaseModel):
    paused: bool


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.post("/goal", response_model=GoalResponse)
async def send_goal(req: GoalRequest) -> GoalResponse:
    """
    Send a NavigateToPose action goal directly via rclpy.

    Converts (x, y, yaw_deg) in the map frame to a PoseStamped and sends it
    to the /navigate_to_pose action server. Returns once bt_navigator has
    accepted or rejected the goal (not when navigation completes).

    Returns ok=false with HTTP 200 if bt_navigator rejects the goal, allowing
    the frontend to display a "goal rejected" message instead of treating it as
    a network/server error.
    """
    try:
        result = await ros_action_client.send_nav_goal(
            x=req.x,
            y=req.y,
            yaw_deg=req.yaw_deg,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    accepted: bool = result["accepted"]
    goal_id: str = result["goal_id"]

    logger.info(
        "send_goal: accepted=%s goal_id=%s (%.2f, %.2f, %.1f°)",
        accepted, goal_id, req.x, req.y, req.yaw_deg,
    )
    return GoalResponse(ok=accepted, goal_id=goal_id)


@router.get("/goal/status", response_model=StatusResponse)
async def get_goal_status() -> StatusResponse:
    """
    Return the current cached navigation status.

    Reads directly from the in-memory cache maintained by ros_action_client
    (updated by feedback and result callbacks) — no ROS call is made per
    request.
    """
    nav_status = await ros_action_client.get_nav_status()

    return StatusResponse(
        active=nav_status["active"],
        goal_id=ros_action_client._active_goal_id,  # module-level cache
        status=nav_status["status"],
        distance_remaining=nav_status["distance_remaining"],
        goal=nav_status.get("goal"),
        paused=nav_status.get("paused", False),
    )


@router.post("/pause")
async def pause_nav() -> dict:
    """Pause navigation: cancels the active Nav2 goal and holds position."""
    try:
        return await ros_action_client.pause_nav_goal()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/resume")
async def resume_nav() -> dict:
    """Resume navigation: resends the goal to continue navigation to the destination."""
    try:
        return await ros_action_client.resume_nav_goal()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/goal", response_model=CancelResponse)
async def cancel_goal() -> CancelResponse:
    """
    Cancel the active navigation goal via rclpy.

    If no goal is active, returns ok=True immediately.
    """
    try:
        result = await ros_action_client.cancel_nav_goal()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return CancelResponse(ok=result["ok"], message=result["message"])
