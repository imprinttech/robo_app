"""
routers/topics.py — FastAPI router for topic publishing, discovery, and reading.

Endpoints:
  POST /api/publish
      Serialize a ROS 2 message from the request body and PUT it to the
      Zenoh REST topics bridge.  The serialization is fully generic via
      ros_messages.serialize(), so any message type works without code changes.

      Request body (JSON):
        {
          "topic":    "/cmd_vel_teleop",
          "msg_type": "geometry_msgs/msg/Twist",
          "data":     { "linear": {"x": 0.3, "y": 0.0, "z": 0.0},
                        "angular": {"x": 0.0, "y": 0.0, "z": 0.0} }
        }

      If msg_type is "geometry_msgs/msg/TwistStamped" and the frontend passes
      only Twist-style data (linear/angular at top level), this router wraps
      it automatically inside the 'twist' field.

  GET /api/topics/known
      Returns the list of well-known cmd_vel topics for the warehouse robot.
      The frontend uses this to populate its topic-selector dropdown without
      hard-coding anything.

  GET /api/topics/{topic_path}?msg_type=<ros_type>
      Read the latest cached value of any ROS topic from the Zenoh topics
      bridge.  Decodes the CDR binary response and returns a plain JSON dict.
      Returns 404 if the topic has no cached value yet.

  GET /api/pose
      Convenience endpoint — reads the AMCL pose (/amcl_pose) and returns
      the robot's estimated x, y, yaw in the map frame.
"""

from __future__ import annotations

import importlib
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, field_validator

from app import ros_messages, zenoh_client
from app import pose_cache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["topics"])

# ── Known topics offered in the UI dropdown ────────────────────────────────────
KNOWN_TOPICS: list[dict[str, str]] = [
    {"topic": "/cmd_vel_teleop",    "msg_type": "geometry_msgs/msg/Twist"},
    {"topic": "/cmd_vel_nav",       "msg_type": "geometry_msgs/msg/Twist"},
    {"topic": "/cmd_vel_smoothed",  "msg_type": "geometry_msgs/msg/Twist"},
    {"topic": "/diff_cont/cmd_vel", "msg_type": "geometry_msgs/msg/TwistStamped"},
]


# ── Request / response models ──────────────────────────────────────────────────
class PublishRequest(BaseModel):
    topic: str
    msg_type: str
    data: dict[str, Any]

    @field_validator("topic")
    @classmethod
    def topic_must_start_with_slash(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError("topic must start with '/'")
        return v


class PublishResponse(BaseModel):
    ok: bool
    topic: str
    msg_type: str
    zenoh_status: int


class KnownTopicEntry(BaseModel):
    topic: str
    msg_type: str


# ── Helpers ────────────────────────────────────────────────────────────────────
def _maybe_wrap_twist_stamped(msg_type: str, data: dict[str, Any]) -> dict[str, Any]:
    """
    If the message type is TwistStamped but the frontend sent flat Twist data
    (with 'linear'/'angular' at the top level), wrap it inside the 'twist' key
    automatically so the frontend never has to know about the wrapping.
    """
    if "TwistStamped" in msg_type and "twist" not in data:
        twist_keys = {"linear", "angular"}
        if twist_keys.intersection(data.keys()):
            return {
                "header": data.get("header", {"frame_id": "base_footprint"}),
                "twist": {k: v for k, v in data.items() if k in twist_keys},
            }
    return data


# ── Routes ────────────────────────────────────────────────────────────────────
@router.get("/topics/known", response_model=list[KnownTopicEntry])
async def get_known_topics() -> list[dict[str, str]]:
    """Return the statically configured list of cmd_vel topics for the robot."""
    return KNOWN_TOPICS


@router.post("/publish", response_model=PublishResponse)
async def publish_topic(req: PublishRequest) -> PublishResponse:
    """
    Serialize a ROS 2 message and publish it via the Zenoh REST bridge.

    Steps:
      1. Optionally wrap flat Twist data into TwistStamped structure.
      2. CDR-serialize via ros_messages.serialize() (fully generic).
      3. PUT the bytes to the Zenoh topics REST bridge.
    """
    # 1. Auto-wrap TwistStamped if needed
    coerced_data = _maybe_wrap_twist_stamped(req.msg_type, req.data)

    # 2. Serialize to CDR bytes
    try:
        payload = ros_messages.serialize(req.msg_type, coerced_data)
    except (ValueError, RuntimeError) as exc:
        logger.error("Serialization failed for %s: %s", req.topic, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # 3. PUT to Zenoh bridge
    try:
        resp = await zenoh_client.put_topic(req.topic, payload)
    except httpx.RequestError as exc:
        logger.error("Zenoh bridge unreachable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Cannot reach Zenoh bridge: {exc}",
        ) from exc

    if not resp.is_success:
        logger.warning(
            "Zenoh bridge returned %s for topic %s", resp.status_code, req.topic
        )
        raise HTTPException(
            status_code=502,
            detail=f"Zenoh bridge returned HTTP {resp.status_code}",
        )

    logger.debug("Published %s (%d bytes) to %s", req.msg_type, len(payload), req.topic)
    return PublishResponse(
        ok=True,
        topic=req.topic,
        msg_type=req.msg_type,
        zenoh_status=resp.status_code,
    )


# ── Generic topic read ─────────────────────────────────────────────────────────

class TopicReadResponse(BaseModel):
    topic: str
    msg_type: str
    data: dict[str, Any]


@router.get("/topics/{topic_path:path}", response_model=TopicReadResponse)
async def read_topic(
    topic_path: str,
    msg_type: str = Query(..., description="ROS 2 message type, e.g. geometry_msgs/msg/PoseWithCovarianceStamped"),
) -> TopicReadResponse:
    """
    Read the latest cached value of a ROS topic from the Zenoh topics bridge.

    The topic_path should be the topic name WITHOUT a leading slash
    (the Vite proxy and FastAPI path handle routing).  For example:
      GET /api/topics/amcl_pose?msg_type=geometry_msgs/msg/PoseWithCovarianceStamped

    The Zenoh topics REST bridge returns a JSON array envelope:
      [{"key": "<topic>", "value": "<base64-CDR>", "encoding": "..."}]
    or [] when there is no cached value, or [{"key": "ERROR", ...}] on error.

    IMPORTANT — Zenoh storage limitation:
      The Zenoh topics REST bridge (port 7777) only returns data for topics
      that have an explicit Zenoh memory storage configured for their key
      expression. Without a storage, GET returns [] even when the topic is
      actively published in ROS 2. Topics with TRANSIENT_LOCAL QoS (e.g.
      /amcl_pose, /map) are particularly affected because the bridge may
      not match their QoS profile correctly.

      /api/pose deliberately bypasses this limitation by using a native
      rclpy subscriber (see pose_cache.py) instead of going through Zenoh.

    Returns 404 if the topic has no cached value (Zenoh returns [] or ERROR).
    Returns 502 if the CDR cannot be decoded.
    """
    import base64

    ros_topic = f"/{topic_path}"
    try:
        resp = await zenoh_client.get_topic(ros_topic)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=503, detail=f"Zenoh bridge unreachable: {exc}") from exc

    # Parse the JSON array envelope from the Zenoh topics REST bridge.
    # Format: [{"key": "...", "value": "<base64-CDR>", "encoding": "..."}]
    try:
        entries = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Zenoh bridge returned non-JSON body: {exc}") from exc

    if not entries:
        raise HTTPException(status_code=404, detail=f"No cached value for topic {ros_topic}")

    first = entries[0]
    if first.get("key") == "ERROR":
        raise HTTPException(status_code=404, detail=f"No cached value for topic {ros_topic}")

    # Base64-decode the CDR payload from the envelope's "value" field.
    raw_b64 = first.get("value", "")
    if not raw_b64:
        raise HTTPException(status_code=404, detail=f"No value in Zenoh response for {ros_topic}")

    try:
        cdr_bytes = base64.b64decode(raw_b64)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to base64-decode topic payload: {exc}") from exc

    # CDR-deserialize using the provided msg_type.
    try:
        from rclpy.serialization import deserialize_message
        from rosidl_runtime_py.convert import message_to_ordereddict

        parts = msg_type.strip().split("/")
        if len(parts) != 3:
            raise ValueError(f"msg_type must be 'pkg/msg/Cls', got {msg_type!r}")
        module = importlib.import_module(f"{parts[0]}.{parts[1]}")
        cls = getattr(module, parts[2])
        msg_obj = deserialize_message(cdr_bytes, cls)
        data_dict = dict(message_to_ordereddict(msg_obj))
    except Exception as exc:
        logger.error("CDR decode failed for %s / %s: %s", ros_topic, msg_type, exc)
        raise HTTPException(status_code=502, detail=f"CDR decode error: {exc}") from exc

    return TopicReadResponse(topic=ros_topic, msg_type=msg_type, data=data_dict)


# ── Convenience pose endpoint ─────────────────────────────────────────────────

class PoseResponse(BaseModel):
    x: float
    y: float
    yaw_deg: float


@router.get("/pose", response_model=PoseResponse)
async def get_robot_pose() -> PoseResponse:
    """
    Return the robot's estimated pose from /amcl_pose (AMCL localization).

    Reads from the native rclpy subscriber cache (pose_cache.py) rather than
    the Zenoh topics bridge. The Zenoh topics REST bridge requires an explicit
    memory storage to be configured for /amcl_pose, and also may not match
    AMCL's TRANSIENT_LOCAL QoS correctly. The pose_cache subscriber uses a
    native rclpy node with matching TRANSIENT_LOCAL QoS, ensuring the latched
    pose is received immediately on startup even if AMCL published before
    the backend started.

    Returns 404 if AMCL has not published a pose yet (localization not running
    or /initialpose not set).
    """
    cached = pose_cache.get_cached_pose()
    if cached is None:
        raise HTTPException(
            status_code=404,
            detail="AMCL pose not available yet — localization may still be initializing",
        )
    return PoseResponse(
        x=cached["x"],
        y=cached["y"],
        yaw_deg=cached["yaw_deg"],
    )
