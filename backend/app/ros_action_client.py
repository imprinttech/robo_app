"""
ros_action_client.py — Direct rclpy-based Nav2 action client.

WHY NOT THROUGH ZENOH:
  The Zenoh actions bridge (port 9999) has two fundamental problems that prevent
  reliable navigation:
    1. send_goal responses contain a Zenoh "ERROR" key instead of a decoded
       `accepted` boolean, so we can never tell whether bt_navigator accepted
       the goal.
    2. The _action/status and _action/feedback sub-interfaces are routed as
       plain topics (not queryables) by the bridge, so GET requests return []
       — same root issue we already fixed for AMCL pose (pose_cache.py) and
       map service calls (ros_service_caller.py).

  Rather than fighting Zenoh bridge internals, we bypass it entirely and use a
  native rclpy.action.ActionClient inside the backend process, exactly as we do
  for AMCL pose reading in pose_cache.py and service calls in
  ros_service_caller.py.

Usage:
    from app.ros_action_client import send_nav_goal, get_nav_status, cancel_nav_goal

    result = await send_nav_goal(x=1.5, y=-0.3, yaw_deg=90.0)
    # {"accepted": True, "goal_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}

    status = await get_nav_status()
    # {"active": True, "status": "EXECUTING", "distance_remaining": 2.34}

    cancel = await cancel_nav_goal()
    # {"ok": True, "message": "Cancelled goal <id>"}
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
import uuid as _uuid_mod
from typing import Any

logger = logging.getLogger(__name__)

# ── Shared rclpy node (created once, reused for all action calls) ──────────────
_node_lock = threading.RLock()
_node: Any = None
_executor_thread: threading.Thread | None = None

# ── Module-level state cache (single active goal assumption) ───────────────────
_state_lock = threading.Lock()
_active_goal_handle: Any = None          # rclpy GoalHandle or None
_active_goal_id: str = ""                # UUID string
_current_status: str = "UNKNOWN"         # human-readable status string
_distance_remaining: float = 0.0         # metres, updated by feedback callback
_active_goal_coords: dict | None = None  # {"x": float, "y": float, "yaw_deg": float} or None
_paused_goal_coords: dict | None = None  # Preserves goal coordinates while navigation is paused
_is_paused: bool = False                 # Tracks if Nav2 navigation is paused

# ── Status integer → string mapping (matches action_msgs/msg/GoalStatus) ───────
# GoalStatus integer constants from action_msgs.msg.GoalStatus:
#   STATUS_UNKNOWN   = 0
#   STATUS_ACCEPTED  = 1
#   STATUS_EXECUTING = 2
#   STATUS_CANCELING = 3
#   STATUS_SUCCEEDED = 4
#   STATUS_CANCELED  = 5
#   STATUS_ABORTED   = 6
_STATUS_MAP = {
    0: "UNKNOWN",
    1: "ACCEPTED",
    2: "EXECUTING",
    3: "CANCELING",
    4: "SUCCEEDED",
    5: "CANCELED",
    6: "ABORTED",
}


def _get_or_create_node() -> Any:
    """
    Return the shared rclpy node, creating it (and its spin thread) if needed.
    Thread-safe. Safe to call multiple times — follows ros_service_caller.py's
    pattern exactly.
    """
    global _node, _executor_thread

    if _node is not None:
        return _node

    with _node_lock:
        if _node is not None:
            return _node

        import rclpy
        from rclpy.executors import MultiThreadedExecutor
        from app.rclpy_init import ensure_rclpy_init

        ensure_rclpy_init()

        _node = rclpy.create_node("backend_action_client")

        # MultiThreadedExecutor so this node and any other rclpy nodes (e.g.
        # backend_service_caller) can spin concurrently without the
        # "Executor is already spinning" error.
        executor = MultiThreadedExecutor()
        executor.add_node(_node)

        _executor_thread = threading.Thread(
            target=executor.spin,
            name="backend_action_client_spin",
            daemon=True,
        )
        _executor_thread.start()
        logger.info("ros_action_client: created node and started spin thread")

    return _node


_action_client: Any = None


def _get_or_create_action_client() -> Any:
    """Return the shared NavigateToPose ActionClient, creating it if needed."""
    global _action_client
    if _action_client is not None:
        return _action_client

    node = _get_or_create_node()

    with _node_lock:
        if _action_client is not None:
            return _action_client

        from rclpy.action import ActionClient
        from nav2_msgs.action import NavigateToPose

        _action_client = ActionClient(node, NavigateToPose, "/navigate_to_pose")
        return _action_client


def _deg_to_quat_z(yaw_deg: float) -> dict[str, float]:
    """Convert yaw in degrees to a Z-axis quaternion (2-D navigation)."""
    half = math.radians(yaw_deg) / 2.0
    return {"x": 0.0, "y": 0.0, "z": math.sin(half), "w": math.cos(half)}


def _await_rclpy_future(rclpy_future: Any, timeout: float = 15.0) -> Any:
    """
    Block until an rclpy Future completes, polling with a short sleep.

    rclpy Futures are not directly awaitable in Python's asyncio sense, so we
    poll them in a thread-pool executor (called via run_in_executor from the
    async wrappers below). This mirrors the pattern ros_service_caller.py uses
    for service futures.
    """
    deadline = time.monotonic() + timeout
    while not rclpy_future.done():
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"rclpy future did not complete within {timeout:.1f}s"
            )
        time.sleep(0.02)
    return rclpy_future.result()


def _blocking_send_nav_goal(x: float, y: float, yaw_deg: float) -> dict:
    """
    Synchronous rclpy action goal send. Run in thread-pool so the asyncio
    event loop is not blocked.
    """
    from nav2_msgs.action import NavigateToPose
    from rosidl_runtime_py.set_message import set_message_fields

    global _active_goal_handle, _active_goal_id, _current_status, _distance_remaining, _active_goal_coords, _is_paused

    action_client = _get_or_create_action_client()

    if not action_client.wait_for_server(timeout_sec=15.0):
        raise RuntimeError(
            "Action server /navigate_to_pose not available within 15s"
        )

    # Build goal message
    goal_msg = NavigateToPose.Goal()
    quat = _deg_to_quat_z(yaw_deg)
    set_message_fields(goal_msg, {
        "pose": {
            "header": {"frame_id": "map"},
            "pose": {
                "position": {"x": x, "y": y, "z": 0.0},
                "orientation": quat,
            },
        },
        "behavior_tree": "",
    })

    def _feedback_callback(feedback_msg) -> None:
        global _distance_remaining, _current_status
        with _state_lock:
            _distance_remaining = float(
                feedback_msg.feedback.distance_remaining
            )
            # First feedback means the goal is actively executing
            if _current_status in ("ACCEPTED", "UNKNOWN"):
                _current_status = "EXECUTING"
        logger.debug(
            "ros_action_client: feedback — distance_remaining=%.3f",
            _distance_remaining,
        )

    # Send goal (returns an rclpy Future for the goal handle)
    send_goal_future = action_client.send_goal_async(
        goal_msg,
        feedback_callback=_feedback_callback,
    )

    # Block until send_goal response arrives (bt_navigator accepted/rejected)
    goal_handle = _await_rclpy_future(send_goal_future, timeout=15.0)

    accepted: bool = bool(goal_handle.accepted)

    # Derive a human-readable UUID string from the 16-byte UUID array
    raw_bytes = bytes(list(goal_handle.goal_id.uuid))
    goal_id_str = str(_uuid_mod.UUID(bytes=raw_bytes))

    logger.info(
        "ros_action_client: send_goal response — accepted=%s goal_id=%s",
        accepted,
        goal_id_str,
    )

    if accepted:
        with _state_lock:
            _active_goal_handle = goal_handle
            _active_goal_id = goal_id_str
            _current_status = "ACCEPTED"
            _distance_remaining = 0.0
            _active_goal_coords = {"x": x, "y": y, "yaw_deg": yaw_deg}
            _is_paused = False

        # Kick off get_result_async() in a daemon thread; it will update
        # the status cache when the action terminates.
        def _wait_for_result() -> None:
            global _current_status, _active_goal_handle, _active_goal_coords, _is_paused, _paused_goal_coords
            try:
                result_future = goal_handle.get_result_async()
                result_response = _await_rclpy_future(
                    result_future, timeout=300.0
                )
                status_int = result_response.status
                terminal = _STATUS_MAP.get(status_int, "UNKNOWN")
                logger.info(
                    "ros_action_client: goal %s finished — status=%s",
                    goal_id_str,
                    terminal,
                )
                with _state_lock:
                    _active_goal_handle = None
                    if _is_paused:
                        _current_status = "PAUSED"
                    else:
                        _current_status = terminal
                        _active_goal_coords = None
                        _paused_goal_coords = None
                        _is_paused = False
            except Exception as exc:
                logger.error(
                    "ros_action_client: _wait_for_result error: %s", exc
                )
                with _state_lock:
                    _active_goal_handle = None
                    if not _is_paused:
                        _current_status = "UNKNOWN"
                        _active_goal_coords = None
                        _paused_goal_coords = None
                        _is_paused = False

        threading.Thread(
            target=_wait_for_result,
            name="nav_goal_result_waiter",
            daemon=True,
        ).start()
    else:
        # Goal rejected — clear any stale state
        with _state_lock:
            _active_goal_handle = None
            _active_goal_id = goal_id_str
            _current_status = "ABORTED"
            _active_goal_coords = None
            _paused_goal_coords = None
            _is_paused = False

    return {"accepted": accepted, "goal_id": goal_id_str}


def _blocking_cancel_nav_goal(is_pause: bool = False) -> dict:
    """
    Synchronous cancel of the active goal. Run in thread-pool.
    If is_pause is True, preserves the active goal coordinates in _paused_goal_coords.
    """
    global _active_goal_handle, _current_status, _active_goal_id, _active_goal_coords, _is_paused, _paused_goal_coords

    with _state_lock:
        handle = _active_goal_handle
        gid = _active_goal_id
        if is_pause and _active_goal_coords is not None:
            _paused_goal_coords = dict(_active_goal_coords)
            _is_paused = True

    if handle is None:
        if is_pause and _paused_goal_coords is not None:
            with _state_lock:
                _is_paused = True
                _current_status = "PAUSED"
            return {"ok": True, "message": "Navigation paused"}
        return {"ok": True, "message": "No active goal to cancel"}

    try:
        cancel_future = handle.cancel_goal_async()
        cancel_response = _await_rclpy_future(cancel_future, timeout=15.0)

        # cancel_response.return_code: 0 = ERROR_NONE (success), others = failure
        # action_msgs/srv/CancelGoal_Response: ERROR_NONE = 0
        ok = cancel_response.return_code == 0
        msg = (
            f"Cancelled goal {gid}"
            if ok
            else f"Cancel rejected for goal {gid} (code={cancel_response.return_code})"
        )
        logger.info("ros_action_client: cancel — %s", msg)

        if ok:
            with _state_lock:
                _active_goal_handle = None
                if is_pause:
                    _current_status = "PAUSED"
                    _is_paused = True
                else:
                    _current_status = "CANCELED"
                    _active_goal_coords = None
                    _paused_goal_coords = None
                    _is_paused = False

        return {"ok": ok, "message": msg}

    except Exception as exc:
        logger.error("ros_action_client: cancel error: %s", exc)
        return {"ok": False, "message": f"Cancel error: {exc}"}


def set_nav_paused(paused: bool) -> None:
    """Update navigation paused flag in memory cache."""
    global _is_paused
    with _state_lock:
        _is_paused = paused
    logger.info("ros_action_client: set_nav_paused -> %s", paused)


# ── Public async API ───────────────────────────────────────────────────────────

async def send_nav_goal(x: float, y: float, yaw_deg: float) -> dict:
    """
    Send a NavigateToPose goal directly via rclpy (NOT through Zenoh).

    Builds a NavigateToPose.Goal with PoseStamped in the "map" frame,
    sends it to the /navigate_to_pose action server, and returns once
    bt_navigator has accepted or rejected the goal.

    Args:
        x:       Target x position in map frame (metres).
        y:       Target y position in map frame (metres).
        yaw_deg: Target heading in degrees (0 = East / +X axis).

    Returns:
        {"accepted": bool, "goal_id": "<uuid-string>"}

    Raises:
        RuntimeError: Action server unreachable, or future timed out.
    """
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        _blocking_send_nav_goal,
        x,
        y,
        yaw_deg,
    )
    return result


async def get_nav_status() -> dict:
    """
    Return the current cached navigation status without blocking.

    Status is updated by real callbacks:
      - feedback_callback fires  → status transitions to EXECUTING
      - get_result_async() resolves → status transitions to terminal value

    Returns:
        {
            "active": bool,
            "status": "ACCEPTED"|"EXECUTING"|"SUCCEEDED"|"CANCELED"|
                      "ABORTED"|"CANCELING"|"UNKNOWN"|"PAUSED",
            "distance_remaining": float  (metres, 0.0 when not active),
            "goal": {"x": float, "y": float, "yaw_deg": float} | None,
            "paused": bool
        }
    """
    with _state_lock:
        status = _current_status
        dist = _distance_remaining
        active = _active_goal_handle is not None
        paused = _is_paused
        coords = _active_goal_coords if active else (_paused_goal_coords if paused else None)

    return {
        "active": active or paused,
        "status": status,
        "distance_remaining": dist,
        "goal": coords,
        "paused": paused,
    }


async def cancel_nav_goal() -> dict:
    """
    Cancel the currently active navigation goal via rclpy (NOT through Zenoh).

    If no goal is active, returns ok=True immediately.

    Returns:
        {"ok": bool, "message": str}
    """
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _blocking_cancel_nav_goal, False)
    return result


async def pause_nav_goal() -> dict:
    """
    Pause navigation: cancels the active Nav2 goal so the robot stops moving immediately,
    while remembering the destination coordinates so navigation can be resumed.
    """
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _blocking_cancel_nav_goal, True)
    # Zero velocity to teleop topic just in case
    try:
        from app import ros_messages, zenoh_client
        payload = ros_messages.serialize("geometry_msgs/msg/Twist", {
            "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
            "angular": {"x": 0.0, "y": 0.0, "z": 0.0},
        })
        await zenoh_client.put_topic("/cmd_vel_teleop", payload)
    except Exception:
        pass
    return {"ok": result.get("ok", False), "paused": True}


async def resume_nav_goal() -> dict:
    """
    Resume navigation: re-sends the saved goal coordinates to Nav2.
    """
    global _paused_goal_coords, _is_paused
    with _state_lock:
        coords = _paused_goal_coords

    if not coords:
        return {"ok": False, "message": "No paused goal to resume"}

    res = await send_nav_goal(
        x=coords["x"],
        y=coords["y"],
        yaw_deg=coords["yaw_deg"],
    )
    accepted = res.get("accepted", False)
    if accepted:
        with _state_lock:
            _is_paused = False
            _paused_goal_coords = None
    return {"ok": accepted, "paused": not accepted, "goal_id": res.get("goal_id", "")}
