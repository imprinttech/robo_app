"""
rclpy_init.py — Single-place rclpy initialisation guard.

rclpy.init() must be called exactly once per process. Multiple modules that
create rclpy nodes (pose_cache.py, ros_service_caller.py) import this module
and call ensure_rclpy_init() before creating nodes.  A threading lock ensures
only one caller wins the race.
"""

from __future__ import annotations

import threading
import logging

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_initialised = False


def ensure_rclpy_init() -> None:
    """
    Initialise rclpy exactly once.  Safe to call from multiple threads.
    """
    global _initialised

    if _initialised:
        return

    with _lock:
        if _initialised:
            return  # another thread won the race

        import rclpy
        try:
            rclpy.init()
            logger.info("rclpy_init: rclpy.init() succeeded")
        except Exception as exc:
            # May already be initialised if running in a context where rclpy
            # was initialised externally (e.g., tests, other frameworks).
            logger.warning("rclpy_init: rclpy.init() raised (may already be initialised): %s", exc)

        _initialised = True
