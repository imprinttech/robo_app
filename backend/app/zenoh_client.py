"""
zenoh_client.py — Thin async HTTP wrapper around the Zenoh REST bridge.

The Zenoh REST bridge exposes two operations relevant here:
  GET  /{key_expr}         → subscribe/query a key (returns JSON or binary)
  PUT  /{key_expr}         → publish binary payload to a key (i.e., a ROS topic)

Topics are mapped from ROS topic names to Zenoh key expressions by stripping
the leading "/" from the ROS topic name.  For example:
  ROS topic  /cmd_vel_teleop  →  Zenoh key  cmd_vel_teleop
"""

import httpx
from app.config import ZENOH_TOPICS_REST_URL


async def put_topic(ros_topic: str, payload: bytes) -> httpx.Response:
    """
    Publish a CDR-serialized binary payload to a ROS topic via the Zenoh REST bridge.

    Args:
        ros_topic: Full ROS topic name including leading slash, e.g. '/cmd_vel_teleop'.
        payload:   CDR-serialized bytes produced by ros_messages.serialize().

    Returns:
        The httpx.Response from the bridge (caller checks .is_success_status).
    """
    # Zenoh key expressions do not have a leading slash.
    key_expr = ros_topic.lstrip("/")
    url = f"{ZENOH_TOPICS_REST_URL}/{key_expr}"

    async with httpx.AsyncClient() as client:
        response = await client.put(
            url,
            content=payload,
            headers={"Content-Type": "application/octet-stream"},
            timeout=5.0,
        )
    return response


async def get_topic(ros_topic: str) -> httpx.Response:
    """
    Query the last value of a ROS topic from the Zenoh REST bridge.

    Args:
        ros_topic: Full ROS topic name including leading slash.

    Returns:
        httpx.Response — usually JSON or binary depending on the topic.
    """
    key_expr = ros_topic.lstrip("/")
    url = f"{ZENOH_TOPICS_REST_URL}/{key_expr}"

    async with httpx.AsyncClient() as client:
        response = await client.get(url, timeout=5.0)
    return response
