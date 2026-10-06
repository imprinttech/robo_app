"""
pose_cache.py — Background rclpy node that subscribes to /amcl_pose and
caches the latest PoseWithCovarianceStamped message in memory.

Why NOT through Zenoh:
  The Zenoh topics REST bridge (port 7777) only returns a cached value when
  it has received at least one publication while running. AMCL uses
  TRANSIENT_LOCAL QoS durability; if the bridge started after the last
  publish — or its subscriber didn't match the QoS — the cache stays empty
  and GET /amcl_pose returns []. Rather than fighting Zenoh storage config,
  we bypass Zenoh entirely for pose and use a native rclpy subscriber inside
  the backend process, which correctly handles TRANSIENT_LOCAL durability.

Usage:
  Call start_pose_subscriber() once at FastAPI startup (inside a lifespan or
  on_event("startup") handler). The background thread will spin indefinitely.
  Call get_cached_pose() anywhere to retrieve the latest pose dict, or None
  if no message has arrived yet.
"""

from __future__ import annotations

import logging
import math
import threading
from typing import Any

logger = logging.getLogger(__name__)

# ── Thread-safe cache ──────────────────────────────────────────────────────────
_lock = threading.Lock()
_cached_pose: dict[str, Any] | None = None   # None until first message arrives
_spin_thread: threading.Thread | None = None


def get_cached_pose() -> dict[str, Any] | None:
    """
    Return the latest decoded AMCL pose, or None if nothing received yet.

    The returned dict has keys: x, y, yaw_deg (all floats, rounded to 4 dp).
    """
    with _lock:
        return _cached_pose


def start_pose_subscriber() -> None:
    """
    Start the background rclpy spin thread.

    Safe to call multiple times — subsequent calls are no-ops if the thread
    is already running. Must be called after rclpy.init() (which we call
    inside the thread to avoid conflicting with any existing rclpy context).
    """
    global _spin_thread
    if _spin_thread is not None and _spin_thread.is_alive():
        logger.info("pose_cache: background thread already running, skipping init")
        return

    _spin_thread = threading.Thread(
        target=_spin_node,
        name="amcl_pose_subscriber",
        daemon=True,   # dies when the main process exits
    )
    _spin_thread.start()
    logger.info("pose_cache: background rclpy subscriber thread started")


# ── Internal ───────────────────────────────────────────────────────────────────

def _spin_node() -> None:
    """
    Entry point for the background thread.

    Initialises rclpy, creates a node + subscriber, and spins forever.
    Any exception is logged and the thread exits cleanly (the rest of the
    backend keeps running, /api/pose will just keep returning 404 until the
    thread is restarted / the backend is reloaded).
    """
    try:
        import rclpy
        from rclpy.node import Node
        from rclpy.qos import (
            QoSProfile,
            QoSDurabilityPolicy,
            QoSReliabilityPolicy,
            QoSHistoryPolicy,
        )
        from geometry_msgs.msg import PoseWithCovarianceStamped
        from app.rclpy_init import ensure_rclpy_init
    except ImportError as exc:
        logger.error(
            "pose_cache: cannot import rclpy / geometry_msgs — "
            "is the ROS 2 workspace sourced? Error: %s",
            exc,
        )
        return

    ensure_rclpy_init()

    # Match AMCL's TRANSIENT_LOCAL QoS so we receive the latched last pose
    # immediately on subscription, even if it was published before we started.
    amcl_qos = QoSProfile(
        depth=1,
        durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
        reliability=QoSReliabilityPolicy.RELIABLE,
        history=QoSHistoryPolicy.KEEP_LAST,
    )

    try:
        node = rclpy.create_node("backend_pose_cache")
    except Exception as exc:
        logger.error("pose_cache: failed to create rclpy node: %s", exc)
        return

    def _on_pose(msg: PoseWithCovarianceStamped) -> None:
        global _cached_pose
        pose = msg.pose.pose
        q = pose.orientation
        yaw_rad = math.atan2(
            2.0 * (q.w * q.z + q.x * q.y),
            1.0 - 2.0 * (q.y * q.y + q.z * q.z),
        )
        decoded = {
            "x":       round(float(pose.position.x), 4),
            "y":       round(float(pose.position.y), 4),
            "yaw_deg": round(math.degrees(yaw_rad), 2),
        }
        with _lock:
            _cached_pose = decoded
        logger.debug("pose_cache: updated pose → %s", decoded)

    node.create_subscription(
        PoseWithCovarianceStamped,
        "/amcl_pose",
        _on_pose,
        amcl_qos,
    )
    logger.info("pose_cache: subscribed to /amcl_pose with TRANSIENT_LOCAL QoS")

    try:
        from rclpy.executors import MultiThreadedExecutor
        executor = MultiThreadedExecutor()
        executor.add_node(node)
        executor.spin()
    except Exception as exc:
        logger.error("pose_cache: executor.spin() exited with error: %s", exc)
    finally:
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            pass
        logger.info("pose_cache: background thread exiting")
