"""
ros_services.py — Generic ROS 2 service-call helper via the Zenoh REST bridge.

Design goal:
  Callers pass a service path (e.g. "/map_server/map"), a service type string
  (e.g. "nav_msgs/srv/GetMap"), and a plain Python dict for the request fields.
  This module:
    1. Dynamically imports the correct Request and Response message classes.
    2. Populates the request using rosidl_runtime_py.set_message.set_message_fields().
    3. Serializes the request to CDR bytes via rclpy.serialization.serialize_message().
    4. GETs the CDR bytes to the Zenoh services REST bridge (port 8888 by default).
       NOTE: Zenoh's REST API only supports GET, PUT, and DELETE — there is NO POST.
       ROS2 service Queryables are invoked via HTTP GET with the serialized request
       carried as the request body. We use httpx.build_request("GET", ...) + send()
       rather than client.get() because many HTTP toolkits strip GET request bodies.
    5. The response body is a JSON array:
         [{"key": "...", "value": "<base64-CDR>", "encoding": "...", ...}]
       or an error sentinel:
         [{"key": "ERROR", "value": "<base64-msg>", ...}]
    6. Decodes the first element's value (base64 → bytes → CDR → Python dict).

The Zenoh services REST bridge responds to GET-with-body:
  - Success: HTTP 200, body = JSON array with one element whose "value" is the
             base64-encoded CDR response.
  - Timeout: HTTP 200, body = [{"key": "ERROR", "value": base64("Timeout")}]
  - Error:   HTTP 200, body = [{"key": "ERROR", ...}]

Usage example:
    result = await call_service(
        service_path="/map_server/map",
        srv_type="nav_msgs/srv/GetMap",
        request_data={},
        timeout=65.0,
    )
    # result is a plain dict matching the ROS Response message fields.
"""

from __future__ import annotations

import base64
import importlib
import logging
from typing import Any

import httpx
from app.config import ZENOH_SERVICES_REST_URL

logger = logging.getLogger(__name__)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _import_srv_classes(srv_type: str):
    """
    Resolve a ROS 2 service type string to its (Request, Response) Python classes.

    Args:
        srv_type: String in "package/srv/SrvName" format,
                  e.g. "nav_msgs/srv/GetMap".

    Returns:
        Tuple (RequestClass, ResponseClass).

    Raises:
        ValueError: Bad format or class not found.
    """
    parts = srv_type.strip().split("/")
    if len(parts) != 3:
        raise ValueError(
            f"srv_type must be 'package/srv/SrvName', got: {srv_type!r}"
        )

    package, _kind, class_name = parts  # _kind is "srv"
    module_path = f"{package}.{_kind}"

    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        raise ValueError(
            f"Cannot import ROS 2 service module '{module_path}'. "
            f"Source your workspace. Error: {exc}"
        ) from exc

    try:
        srv_cls = getattr(module, class_name)
    except AttributeError as exc:
        raise ValueError(
            f"Module '{module_path}' has no service class '{class_name}'."
        ) from exc

    return srv_cls.Request, srv_cls.Response


def _serialize_request(srv_type: str, request_data: dict[str, Any]) -> bytes:
    """CDR-serialize a service request dict."""
    try:
        from rosidl_runtime_py.set_message import set_message_fields
        from rclpy.serialization import serialize_message
    except ImportError as exc:
        raise RuntimeError("ROS 2 Python packages not found. Source workspace.") from exc

    RequestCls, _ = _import_srv_classes(srv_type)
    req_msg = RequestCls()
    if request_data:
        try:
            set_message_fields(req_msg, request_data)
        except Exception as exc:
            raise ValueError(
                f"Failed to populate {srv_type}.Request from {request_data!r}: {exc}"
            ) from exc

    return serialize_message(req_msg)


def _deserialize_response(srv_type: str, cdr_bytes: bytes) -> dict[str, Any]:
    """CDR-deserialize a service response into a plain Python dict."""
    try:
        from rclpy.serialization import deserialize_message
        from rosidl_runtime_py.convert import message_to_ordereddict
    except ImportError as exc:
        raise RuntimeError("ROS 2 Python packages not found. Source workspace.") from exc

    _, ResponseCls = _import_srv_classes(srv_type)
    try:
        resp_msg = deserialize_message(cdr_bytes, ResponseCls)
    except Exception as exc:
        raise RuntimeError(
            f"CDR deserialization failed for {srv_type}.Response: {exc}"
        ) from exc

    return dict(message_to_ordereddict(resp_msg))


# ── Public API ────────────────────────────────────────────────────────────────

async def call_service(
    service_path: str,
    srv_type: str,
    request_data: dict[str, Any],
    timeout: float = 30.0,
) -> dict[str, Any]:
    """
    Call a ROS 2 service via the Zenoh services REST bridge.

    Args:
        service_path:  ROS service name with leading slash, e.g. "/map_server/map".
        srv_type:      Service type string "package/srv/SrvName".
        request_data:  Dict of request field values (empty dict for requests with
                       no fields, e.g. GetMap).
        timeout:       HTTP request timeout in seconds (default 30 s for map data).

    Returns:
        Plain Python dict matching the ROS service Response message fields.

    Raises:
        ValueError:    Bad srv_type format or serialization error.
        RuntimeError:  Zenoh service error/timeout or deserialization failure.
        httpx.RequestError: Network error reaching the Zenoh bridge.
    """
    # 1. Serialize the request
    req_cdr = _serialize_request(srv_type, request_data)

    # 2. GET (with body) to the Zenoh services bridge.
    #    Zenoh REST API only supports GET / PUT / DELETE — there is no POST.
    #    ROS2 service Queryables are invoked via HTTP GET with the CDR request
    #    as the body. We use build_request("GET") + send() so that httpx does
    #    not strip the body (client.get() often silently drops it).
    key_expr = service_path.lstrip("/")
    url = f"{ZENOH_SERVICES_REST_URL}/{key_expr}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            request = client.build_request(
                "GET",
                url,
                content=req_cdr,
                headers={"Content-Type": "application/octet-stream"},
            )
            response = await client.send(request)
        except httpx.RequestError as exc:
            raise httpx.RequestError(
                f"Cannot reach Zenoh services bridge at {url}: {exc}"
            ) from exc

    if not response.is_success:
        raise RuntimeError(
            f"Zenoh services bridge returned HTTP {response.status_code}"
        )

    # 3. Parse the JSON envelope
    #    Expected: [{"key": "...", "value": "<base64>", "encoding": "...", ...}]
    try:
        entries = response.json()
    except Exception as exc:
        raise RuntimeError(
            f"Zenoh services bridge returned non-JSON body: {exc}"
        ) from exc

    if not entries:
        raise RuntimeError(
            f"Zenoh services bridge returned empty response for {service_path}"
        )

    first = entries[0]

    # Check for error sentinel
    if first.get("key") == "ERROR":
        raw_val = first.get("value", "")
        try:
            error_msg = base64.b64decode(raw_val).decode("utf-8", errors="replace")
        except Exception:
            error_msg = raw_val
        raise RuntimeError(
            f"Zenoh service call to {service_path} failed: {error_msg}"
        )

    # 4. Decode the base64-encoded CDR response value
    raw_b64 = first.get("value", "")
    if not raw_b64:
        raise RuntimeError(
            f"Zenoh services bridge returned entry with no 'value' for {service_path}"
        )

    try:
        cdr_bytes = base64.b64decode(raw_b64)
    except Exception as exc:
        raise RuntimeError(
            f"Failed to base64-decode service response for {service_path}: {exc}"
        ) from exc

    # 5. CDR-deserialize the response
    return _deserialize_response(srv_type, cdr_bytes)
