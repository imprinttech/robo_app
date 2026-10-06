"""
ros_service_caller.py — Direct rclpy-based ROS 2 service caller.

WHY NOT THROUGH ZENOH:
  The Zenoh services REST bridge (port 8888) creates a DDS route for each
  ROS 2 service it discovers, but in practice the bridge's DDS client for
  services does not always successfully complete call-and-response cycles.
  Every GET request to the bridge results in a Zenoh router timeout
  (`Didn't receive final reply for query ... Timeout(65s)`) even though direct
  rclpy service calls to the same service complete in < 3 seconds.

  Rather than fighting Zenoh bridge internals, we bypass it entirely for
  service calls and use native rclpy, exactly as we do for AMCL pose reading
  in pose_cache.py.

Usage:
    from app.ros_service_caller import call_service_direct

    result_dict = await call_service_direct(
        service_name="/map_server/map",
        srv_type="nav_msgs/srv/GetMap",
        request_data={},
        timeout=15.0,
    )
    # result_dict is a plain Python dict matching the ROS Response fields.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

# ── Shared rclpy node (created once, reused for all service calls) ─────────────
_node_lock = threading.Lock()
_node: Any = None
_executor_thread: threading.Thread | None = None


def _get_or_create_node() -> Any:
    """
    Return the shared rclpy node, creating it (and its spin thread) if needed.
    Thread-safe. Safe to call multiple times.
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

        _node = rclpy.create_node("backend_service_caller")

        # Use MultiThreadedExecutor so multiple rclpy nodes can be spun
        # concurrently without the "Executor is already spinning" error
        # that occurs when two threads each call rclpy.spin() independently.
        executor = MultiThreadedExecutor()
        executor.add_node(_node)

        _executor_thread = threading.Thread(
            target=executor.spin,
            name="backend_service_caller_spin",
            daemon=True,
        )
        _executor_thread.start()
        logger.info("ros_service_caller: created node and started spin thread")

    return _node


def _resolve_srv_class(srv_type: str):
    """
    Resolve 'package/srv/SrvName' string to the service class.
    Returns the service class (e.g. nav_msgs.srv.GetMap).
    """
    parts = srv_type.strip().split("/")
    if len(parts) != 3:
        raise ValueError(f"srv_type must be 'package/srv/SrvName', got: {srv_type!r}")
    package, kind, class_name = parts
    if kind != "srv":
        raise ValueError(f"Expected 'srv' as the middle component, got: {kind!r}")
    module = importlib.import_module(f"{package}.{kind}")
    try:
        return getattr(module, class_name)
    except AttributeError as exc:
        raise ValueError(f"Module '{package}.{kind}' has no class '{class_name}'.") from exc


def _blocking_call_service(
    service_name: str,
    srv_type: str,
    request_data: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    """
    Synchronous rclpy service call. Run this in a thread pool to avoid blocking
    the asyncio event loop.
    """
    from rosidl_runtime_py.set_message import set_message_fields
    from rosidl_runtime_py.convert import message_to_ordereddict

    srv_cls = _resolve_srv_class(srv_type)
    node = _get_or_create_node()

    client = node.create_client(srv_cls, service_name)
    try:
        # Wait for service to be available (up to 5 s or the full timeout)
        wait_secs = min(5.0, timeout)
        if not client.wait_for_service(timeout_sec=wait_secs):
            raise RuntimeError(
                f"ROS 2 service '{service_name}' not available within {wait_secs:.0f}s"
            )

        # Build request
        req_msg = srv_cls.Request()
        if request_data:
            set_message_fields(req_msg, request_data)

        # Send async request
        future = client.call_async(req_msg)

        # Poll until done or timeout
        deadline = time.monotonic() + timeout
        while not future.done():
            if time.monotonic() > deadline:
                raise RuntimeError(
                    f"ROS 2 service call to '{service_name}' timed out after {timeout:.1f}s"
                )
            time.sleep(0.02)

        resp = future.result()
        if resp is None:
            raise RuntimeError(f"ROS 2 service '{service_name}' returned None response")

        return dict(message_to_ordereddict(resp))
    finally:
        node.destroy_client(client)


async def call_service_direct(
    service_name: str,
    srv_type: str,
    request_data: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """
    Call a ROS 2 service directly via rclpy (NOT through Zenoh).

    Runs the blocking rclpy call in a thread-pool executor so it does not
    block the FastAPI/asyncio event loop.

    Args:
        service_name:  ROS service name with leading slash, e.g. '/map_server/map'.
        srv_type:      Service type string 'package/srv/SrvName', e.g. 'nav_msgs/srv/GetMap'.
        request_data:  Dict of request field values; pass None or {} for empty requests.
        timeout:       Total seconds to wait for service discovery + response.

    Returns:
        Plain Python dict matching the ROS service Response message fields.

    Raises:
        RuntimeError:  Service unavailable, call timed out, or response is None.
        ValueError:    Malformed srv_type or request_data doesn't match the message type.
    """
    if request_data is None:
        request_data = {}

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,  # default ThreadPoolExecutor
        _blocking_call_service,
        service_name,
        srv_type,
        request_data,
        timeout,
    )
    return result
