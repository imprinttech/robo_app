"""
ros_docking_client.py — Direct rclpy-based ArUco docking action client.

WHY NOT THROUGH ZENOH:
  Same fundamental issues as ros_action_client.py (see its docstring):
  the Zenoh actions bridge can't reliably decode send_goal responses or
  stream action feedback. We use native rclpy.action.ActionClient here,
  sharing the same lazy-singleton node created by ros_action_client._get_or_create_node()
  so there is exactly one rclpy node + spin thread in the backend process.

Action servers (in aruco_ros2/docking_controller.py):
  /dock_robot   — aruco_ros2_interfaces/action/DockRobot
  /undock_robot — aruco_ros2_interfaces/action/UndockRobot
  Both share a busy_lock: a goal on either server is rejected while the
  other is active. Status cache reflects this via the shared `_active_action`
  field — both buttons must be disabled while `_active_action` is not None.

Usage:
    from app.ros_docking_client import send_dock_goal, send_undock_goal, get_docking_status

    result = await send_dock_goal()
    # {"accepted": True, "goal_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}

    status = await get_docking_status()
    # {"active": True, "action": "dock", "status": "EXECUTING",
    #  "phase": "APPROACHING", "battery_percentage": 72.5, "goal_id": "..."}
"""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid as _uuid_mod
from typing import Any

logger = logging.getLogger(__name__)

# ── Reuse the shared node from ros_action_client ───────────────────────────────
# Both modules import the same function; the double-checked lock inside ensures
# only one node is ever created regardless of import order.
from app.ros_action_client import _get_or_create_node

# ── Status integer → string mapping (action_msgs/msg/GoalStatus) ──────────────
_STATUS_MAP = {
    0: "UNKNOWN",
    1: "ACCEPTED",
    2: "EXECUTING",
    3: "CANCELING",
    4: "SUCCEEDED",
    5: "CANCELED",
    6: "ABORTED",
}

# ── Module-level state cache ───────────────────────────────────────────────────
_state_lock = threading.Lock()
_active_goal_handle: Any = None         # rclpy GoalHandle or None
_active_goal_id: str = ""               # UUID string
_active_action: str | None = None       # "dock" | "undock" | None
_current_status: str = "UNKNOWN"        # human-readable status
_current_phase: str = ""                # feedback.phase
_battery_percentage: float = 0.0        # feedback.battery_percentage


def _await_rclpy_future(rclpy_future: Any, timeout: float = 15.0) -> Any:
    """
    Poll an rclpy Future until done, raising RuntimeError on timeout.
    Mirrors the helper in ros_action_client.py.
    """
    import time
    deadline = time.monotonic() + timeout
    while not rclpy_future.done():
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"rclpy future did not complete within {timeout:.1f}s"
            )
        time.sleep(0.02)
    return rclpy_future.result()


_clients_lock = threading.RLock()
_action_clients: dict[str, Any] = {}


def _get_or_create_action_client(action_type: Any, action_name: str) -> Any:
    """Return a shared ActionClient for action_name, creating it if needed."""
    node = _get_or_create_node()
    with _clients_lock:
        if action_name not in _action_clients:
            from rclpy.action import ActionClient
            _action_clients[action_name] = ActionClient(node, action_type, action_name)
        return _action_clients[action_name]


def _blocking_send_goal(action_type: Any, action_name: str, label: str) -> dict:
    """
    Generic blocking goal sender for dock/undock.
    Called from a thread-pool executor so the asyncio loop is not blocked.
    """
    global _active_goal_handle, _active_goal_id, _active_action
    global _current_status, _current_phase, _battery_percentage

    action_client = _get_or_create_action_client(action_type, action_name)

    if not action_client.wait_for_server(timeout_sec=15.0):
        raise RuntimeError(
            f"Action server {action_name} not available within 15s"
        )

    goal_msg = action_type.Goal()
    goal_msg.start = True

    def _feedback_callback(feedback_msg) -> None:
        global _current_status, _current_phase, _battery_percentage
        with _state_lock:
            _current_phase = str(feedback_msg.feedback.phase)
            _battery_percentage = float(feedback_msg.feedback.battery_percentage)
            if _current_status in ("ACCEPTED", "UNKNOWN"):
                _current_status = "EXECUTING"
        logger.debug(
            "ros_docking_client: %s feedback — phase=%s battery=%.1f%%",
            label, _current_phase, _battery_percentage,
        )

    send_goal_future = action_client.send_goal_async(
        goal_msg,
        feedback_callback=_feedback_callback,
    )

    goal_handle = _await_rclpy_future(send_goal_future, timeout=15.0)

    accepted: bool = bool(goal_handle.accepted)

    raw_bytes = bytes(list(goal_handle.goal_id.uuid))
    goal_id_str = str(_uuid_mod.UUID(bytes=raw_bytes))

    logger.info(
        "ros_docking_client: %s send_goal — accepted=%s goal_id=%s",
        label, accepted, goal_id_str,
    )

    if accepted:
        with _state_lock:
            _active_goal_handle = goal_handle
            _active_goal_id = goal_id_str
            _active_action = label
            _current_status = "ACCEPTED"
            _current_phase = ""
            _battery_percentage = 0.0

        def _wait_for_result() -> None:
            global _current_status, _active_goal_handle, _active_action
            try:
                result_future = goal_handle.get_result_async()
                result_response = _await_rclpy_future(
                    result_future, timeout=300.0
                )
                status_int = result_response.status
                terminal = _STATUS_MAP.get(status_int, "UNKNOWN")
                logger.info(
                    "ros_docking_client: %s goal %s finished — status=%s",
                    label, goal_id_str, terminal,
                )
                with _state_lock:
                    _current_status = terminal
                    _active_goal_handle = None
                    _active_action = None
            except Exception as exc:
                logger.error(
                    "ros_docking_client: _wait_for_result error (%s): %s",
                    label, exc,
                )
                with _state_lock:
                    _current_status = "UNKNOWN"
                    _active_goal_handle = None
                    _active_action = None

        threading.Thread(
            target=_wait_for_result,
            name=f"docking_{label}_result_waiter",
            daemon=True,
        ).start()
    else:
        with _state_lock:
            _active_goal_handle = None
            _active_goal_id = goal_id_str
            _active_action = None
            _current_status = "ABORTED"

    return {"accepted": accepted, "goal_id": goal_id_str}


def _blocking_send_dock_goal() -> dict:
    from aruco_ros2_interfaces.action import DockRobot
    return _blocking_send_goal(DockRobot, "/dock_robot", "dock")


def _blocking_send_undock_goal() -> dict:
    from aruco_ros2_interfaces.action import UndockRobot
    return _blocking_send_goal(UndockRobot, "/undock_robot", "undock")


# ── Public async API ───────────────────────────────────────────────────────────

async def send_dock_goal() -> dict:
    """
    Send a DockRobot goal directly via rclpy (NOT through Zenoh).

    Returns:
        {"accepted": bool, "goal_id": "<uuid-string>"}

    Raises:
        RuntimeError: Action server unreachable, or future timed out.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _blocking_send_dock_goal)


async def send_undock_goal() -> dict:
    """
    Send an UndockRobot goal directly via rclpy (NOT through Zenoh).

    Returns:
        {"accepted": bool, "goal_id": "<uuid-string>"}

    Raises:
        RuntimeError: Action server unreachable, or future timed out.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _blocking_send_undock_goal)


async def get_docking_status() -> dict:
    """
    Return the current cached docking status without any blocking ROS call.

    Status is updated by real callbacks:
      - feedback_callback fires           → status transitions to EXECUTING, phase/battery updated
      - get_result_async() resolves       → status transitions to terminal value, active_action cleared

    Returns:
        {
            "active": bool,
            "action": "dock" | "undock" | None,
            "status": "ACCEPTED"|"EXECUTING"|"SUCCEEDED"|"CANCELED"|"ABORTED"|"CANCELING"|"UNKNOWN",
            "phase": str,
            "battery_percentage": float,
            "goal_id": str,
        }
    """
    with _state_lock:
        return {
            "active": _active_goal_handle is not None,
            "action": _active_action,
            "status": _current_status,
            "phase": _current_phase,
            "battery_percentage": _battery_percentage,
            "goal_id": _active_goal_id,
        }
