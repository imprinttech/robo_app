"""
routers/map.py — FastAPI router for map fetching.

Endpoints:
  GET /api/map
      Fetches the OccupancyGrid from the /map_server/map ROS service directly
      via rclpy (bypassing the Zenoh services bridge, which times out when
      routing service calls through its DDS relay layer).
      Converts the OccupancyGrid to a compact JSON payload for the frontend.

      Response JSON:
        {
          "width":      384,           // map width in cells
          "height":     384,           // map height in cells
          "resolution": 0.05,          // metres per cell
          "origin_x":   -10.0,         // map origin X in world coordinates
          "origin_y":   -10.0,         // map origin Y in world coordinates
          "data":       [...]           // flat array of int8 (row-major, ROS order)
        }

      HTTP status codes:
        200 — map returned successfully
        503 — map service timed out / services bridge unreachable
        502 — service call returned an error from Zenoh

Design notes:
  - The raw OccupancyGrid.data is sent as-is (row 0 = bottom-left in ROS).
    The canvas renderer in MapCanvas.tsx flips rows when drawing.
  - No caching is done server-side; the map is re-fetched on every request.
    The frontend only calls this once on mount (or on user refresh).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import ros_service_caller

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["map"])


# ── Response model ────────────────────────────────────────────────────────────

class MapResponse(BaseModel):
    width: int
    height: int
    resolution: float
    origin_x: float
    origin_y: float
    data: list[int]


# ── Route ─────────────────────────────────────────────────────────────────────

@router.get("/map", response_model=MapResponse)
async def get_map() -> MapResponse:
    """
    Fetch the occupancy grid map by calling the /map_server/map ROS service
    directly via rclpy (NOT through the Zenoh bridge).

    The Zenoh services bridge creates a DDS route for map_server/map but its
    DDS relay layer fails to complete the call-and-response cycle, resulting
    in a 65-second router timeout. Direct rclpy calls return in < 3 seconds.
    The blocking rclpy call runs in a thread-pool executor to avoid stalling
    the FastAPI event loop.
    """
    try:
        result = await ros_service_caller.call_service_direct(
            service_name="/map_server/map",
            srv_type="nav_msgs/srv/GetMap",
            request_data={},
            timeout=15.0,
        )
    except (RuntimeError, ValueError) as exc:
        logger.warning("Map service call failed: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Map service unavailable: {exc}",
        ) from exc
    except Exception as exc:
        logger.error("Unexpected error calling map service: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Cannot call map service: {exc}",
        ) from exc

    # result matches the nav_msgs/srv/GetMap.Response structure:
    # { "map": { "info": { "resolution", "width", "height",
    #                       "origin": { "position": { "x", "y" } } },
    #            "data": [...] } }
    try:
        occ_grid = result["map"]
        info = occ_grid["info"]
        origin_pos = info["origin"]["position"]

        return MapResponse(
            width=int(info["width"]),
            height=int(info["height"]),
            resolution=float(info["resolution"]),
            origin_x=float(origin_pos["x"]),
            origin_y=float(origin_pos["y"]),
            data=[int(v) for v in occ_grid["data"]],
        )
    except (KeyError, TypeError, ValueError) as exc:
        logger.error("Unexpected GetMap response structure: %s | data=%s", exc, result)
        raise HTTPException(
            status_code=502,
            detail=f"Unexpected map service response structure: {exc}",
        ) from exc
