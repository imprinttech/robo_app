"""
main.py — FastAPI application entry point.

Starts a REST API on port 8090 (deliberately avoids port 8000 used by the
old dashboard so both can co-exist during migration).

Features:
  - CORS configured for the Vite dev server (default: http://localhost:5173).
    Override with BACKEND_CORS_ORIGINS env var.
  - /healthz endpoint for liveness checks.
  - All topic routes mounted under /api via the topics router.

Run with:
  uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import BACKEND_CORS_ORIGINS, ZENOH_TOPICS_REST_URL, ZENOH_SERVICES_REST_URL, ZENOH_ACTIONS_REST_URL, ZENOH_ROS_DOMAIN
from app.routers import topics as topics_router
from app.routers import map as map_router
from app.routers import nav as nav_router
from app.routers import docking as docking_router
from app import pose_cache

# ── Logging ────────────────────────────────────────────────────────────────────
_log_fmt = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
logging.basicConfig(
    level=logging.INFO,
    format=_log_fmt,
    handlers=[
        logging.StreamHandler(),                                    # keep pty output
        logging.FileHandler("/tmp/uvicorn_app.log", mode="a"),      # TEMP: also write to file
    ],
)
logger = logging.getLogger(__name__)

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Warehouse Robot Dashboard API",
    description=(
        "Backend that bridges the React dashboard to ROS 2 topics "
        "via the Zenoh REST bridge."
    ),
    version="1.0.0",
)

# ── CORS ───────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ──────────────────────────────────────────────────────────────────
app.include_router(topics_router.router)
app.include_router(map_router.router)
app.include_router(nav_router.router)
app.include_router(docking_router.router)


# ── Startup / health ───────────────────────────────────────────────────────────
@app.on_event("startup")
async def on_startup() -> None:
    logger.info("Warehouse Robot Dashboard backend starting up")
    logger.info("  Zenoh topics bridge  : %s", ZENOH_TOPICS_REST_URL)
    logger.info("  Zenoh services bridge: %s", ZENOH_SERVICES_REST_URL)
    logger.info("  Zenoh actions bridge : %s", ZENOH_ACTIONS_REST_URL)
    logger.info("  ROS domain ID        : %d", ZENOH_ROS_DOMAIN)
    logger.info("  CORS origins         : %s", BACKEND_CORS_ORIGINS)

    # Start the native rclpy /amcl_pose subscriber in a background thread.
    # This bypasses the Zenoh topics bridge (which requires explicit memory
    # storage config and may miss TRANSIENT_LOCAL latched messages) and
    # subscribes directly with matching TRANSIENT_LOCAL QoS.
    pose_cache.start_pose_subscriber()

    # Pre-create the rclpy service caller node so the first /api/map request
    # doesn't pay the node + thread creation cost.  This runs in a thread-pool
    # executor to avoid blocking the startup coroutine.
    from app import ros_service_caller
    import asyncio
    asyncio.get_event_loop().run_in_executor(
        None, ros_service_caller._get_or_create_node
    )
    logger.info("  rclpy service caller : pre-warming node")


@app.get("/healthz", tags=["health"])
async def health_check() -> dict:
    """Simple liveness endpoint."""
    return {
        "status": "ok",
        "zenoh_topics_url": ZENOH_TOPICS_REST_URL,
        "ros_domain": ZENOH_ROS_DOMAIN,
    }
