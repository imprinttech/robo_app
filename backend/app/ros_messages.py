"""
ros_messages.py — Generic ROS 2 message serialization.

Design goal:
  Callers pass a 'msg_type' string such as "geometry_msgs/msg/Twist" and a
  plain Python dict with the field values.  This module:
    1. Dynamically imports the correct Python message class.
    2. Populates it using rosidl_runtime_py.set_message.set_message_fields()
       which handles nested types, arrays, and type coercion.
    3. Serializes to CDR bytes via rclpy.serialization.serialize_message().

This means adding new message types to the UI (PoseStamped, OccupancyGrid,
etc.) requires ZERO changes here — just pass the right msg_type string and
data dict from the router.

Usage example:
    payload = serialize(
        msg_type="geometry_msgs/msg/TwistStamped",
        data={
            "header": {"frame_id": "base_footprint"},
            "twist": {"linear": {"x": 0.3}, "angular": {"z": 0.0}},
        },
    )
"""

import importlib
from typing import Any


def _import_message_class(msg_type: str):
    """
    Resolve a ROS 2 message type string to its Python class.

    Args:
        msg_type: String in "package/msg/ClassName" format,
                  e.g. "geometry_msgs/msg/Twist".

    Returns:
        The Python message class.

    Raises:
        ValueError: If the format is wrong or the module/class cannot be found.
    """
    parts = msg_type.strip().split("/")
    if len(parts) != 3:
        raise ValueError(
            f"msg_type must be 'package/msg/ClassName', got: {msg_type!r}"
        )

    package, _kind, class_name = parts  # _kind is typically "msg"

    # ROS 2 Python packages follow the pattern:  <package>.<kind>.<ClassName>
    # e.g. geometry_msgs.msg.Twist
    module_path = f"{package}.{_kind}"
    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        raise ValueError(
            f"Cannot import ROS 2 message module '{module_path}'. "
            f"Is the workspace sourced? Original error: {exc}"
        ) from exc

    try:
        cls = getattr(module, class_name)
    except AttributeError as exc:
        raise ValueError(
            f"Module '{module_path}' has no class '{class_name}'."
        ) from exc

    return cls


def serialize(msg_type: str, data: dict[str, Any]) -> bytes:
    """
    Build a ROS 2 message from a dict and serialize it to CDR bytes.

    Args:
        msg_type: e.g. "geometry_msgs/msg/Twist" or "geometry_msgs/msg/TwistStamped".
        data:     Python dict matching the message field structure.
                  Nested dicts are used for nested message types.
                  Missing fields keep their zero/default values.

    Returns:
        bytes — CDR-serialized message ready to PUT to the Zenoh REST bridge.

    Raises:
        ValueError: On bad msg_type format or unknown class.
        RuntimeError: If rosidl_runtime_py or rclpy serialization fails.
    """
    # Late import so the module can be imported even if ROS is not sourced
    # (useful for type-checking / IDE work).  The actual call will fail fast.
    try:
        from rosidl_runtime_py.set_message import set_message_fields
        from rclpy.serialization import serialize_message
    except ImportError as exc:
        raise RuntimeError(
            "ROS 2 Python packages not found. "
            "Source your ROS 2 workspace before starting the backend."
        ) from exc

    cls = _import_message_class(msg_type)
    msg = cls()

    if data:
        try:
            set_message_fields(msg, data)
        except Exception as exc:
            raise ValueError(
                f"Failed to populate {msg_type} from data {data!r}: {exc}"
            ) from exc

    try:
        return serialize_message(msg)
    except Exception as exc:
        raise RuntimeError(
            f"Failed to CDR-serialize {msg_type}: {exc}"
        ) from exc
