# Warehouse Robot Dashboard — Backend

FastAPI backend that proxies ROS 2 message publishing to the Zenoh REST bridge.

## Prerequisites

* ROS 2 Jazzy (or any distro with your robot's messages built)
* Your `sim_ws` workspace sourced
* `pip install fastapi uvicorn httpx`

## Running

```bash
# 1. Source ROS 2 + workspace (needed for rclpy / message packages)
source /opt/ros/jazzy/setup.bash
source ~/AGV/sim_ws/install/setup.bash

# 2. Install Python deps (one-time)
pip install -r requirements.txt

# 3. Start the backend (from the backend/ directory)
cd warehouse-robot-app/backend
uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload
```

## Environment variables

| Variable                  | Default                 | Purpose                              |
|---------------------------|-------------------------|--------------------------------------|
| `ZENOH_TOPICS_REST_URL`   | `http://localhost:7777` | Zenoh topics bridge REST URL         |
| `ZENOH_SERVICES_REST_URL` | `http://localhost:8888` | Zenoh services bridge REST URL       |
| `ZENOH_ACTIONS_REST_URL`  | `http://localhost:9999` | Zenoh actions bridge REST URL        |
| `ZENOH_ROS_DOMAIN`        | `88`                    | ROS_DOMAIN_ID for the bridge         |
| `BACKEND_CORS_ORIGINS`    | `http://localhost:5173` | Comma-separated CORS allowed origins |

## API

| Method | Path                | Body / Description                                       |
|--------|---------------------|----------------------------------------------------------|
| GET    | `/healthz`          | Liveness check                                           |
| GET    | `/api/topics/known` | Returns list of `{topic, msg_type}` for the dropdown     |
| POST   | `/api/publish`      | `{topic, msg_type, data}` → serializes and PUTs to Zenoh |

## Adding new message types

No backend changes needed.  Just pass the correct `msg_type` string and `data`
dict from the frontend — `ros_messages.serialize()` handles everything generically.
