"""
config.py — Application configuration loaded from environment variables.

Environment variables:
  ZENOH_TOPICS_REST_URL    Base URL of the Zenoh topics REST bridge   (default: http://localhost:7777)
  ZENOH_SERVICES_REST_URL  Base URL of the Zenoh services REST bridge  (default: http://localhost:8888)
  ZENOH_ACTIONS_REST_URL   Base URL of the Zenoh actions REST bridge   (default: http://localhost:9999)
  ZENOH_ROS_DOMAIN         ROS_DOMAIN_ID used by the bridge             (default: 88)
  BACKEND_CORS_ORIGINS     Comma-separated allowed CORS origins         (default: http://localhost:5173)
"""

import os

# ── Zenoh bridge REST endpoints ────────────────────────────────────────────────
ZENOH_TOPICS_REST_URL: str = os.environ.get(
    "ZENOH_TOPICS_REST_URL", "http://localhost:7777"
)
ZENOH_SERVICES_REST_URL: str = os.environ.get(
    "ZENOH_SERVICES_REST_URL", "http://localhost:8888"
)
ZENOH_ACTIONS_REST_URL: str = os.environ.get(
    "ZENOH_ACTIONS_REST_URL", "http://localhost:9999"
)

# ── ROS domain ─────────────────────────────────────────────────────────────────
ZENOH_ROS_DOMAIN: int = int(os.environ.get("ZENOH_ROS_DOMAIN", "88"))

# ── CORS ───────────────────────────────────────────────────────────────────────
_raw_cors = os.environ.get("BACKEND_CORS_ORIGINS", "http://localhost:5173")
BACKEND_CORS_ORIGINS: list[str] = [o.strip() for o in _raw_cors.split(",") if o.strip()]
