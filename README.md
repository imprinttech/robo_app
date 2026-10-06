# Warehouse Robot Dashboard

A modern React + FastAPI dashboard for controlling and monitoring a ROS 2 warehouse robot.
Messages flow: **React UI → FastAPI backend (port 8090) → Zenoh REST bridge (port 7777) → ROS 2**.

## Architecture

```
Browser ─── Vite dev server (5173)
              │  (proxy /api → 8090)
              ▼
         FastAPI backend (8090)
              │  CDR-serialized bytes via HTTP PUT
              ▼
         zenoh-bridge-ros2dds (REST: 7777 / 8888 / 9999)
              │  DDS / UDP
              ▼
         ROS 2 nodes  (ROS_DOMAIN_ID=88)
```

## Prerequisites

- ROS 2 Jazzy with your `sim_ws` workspace built and sourced
- Python ≥ 3.10 with pip
- Node.js ≥ 18 with npm (for the frontend dev server)
- `zenoh-bridge-ros2dds` installed (see `src/zenoh_dashboard/` README)

## Quick Start

### 1. Start the Zenoh bridge (for topics)

```bash
cd src/zenoh_dashboard
zenoh-bridge-ros2dds -c zenoh_topics.json5
```

### 2. Start the backend

```bash
# Terminal A — source ROS 2 first
source /opt/ros/jazzy/setup.bash
source ~/AGV/sim_ws/install/setup.bash

cd warehouse-robot-app/backend
pip install -r requirements.txt   # first time only
pip install --user --break-system-packages -r requirements.txt
sudo apt install uvicorn
uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload
```

### 3. Start the frontend

```bash
# Terminal B
cd warehouse-robot-app/frontend
npm install     # first time only
sudo apt install npm 
npm run dev-+
```

Open **http://localhost:5173** in your browser.

## Environment variables

| Variable                | Default                   | Description                         |
|-------------------------|---------------------------|-------------------------------------|
| `ZENOH_TOPICS_REST_URL` | `http://localhost:7777`   | Zenoh topics bridge REST URL        |
| `ZENOH_ROS_DOMAIN`      | `88`                      | ROS_DOMAIN_ID                       |
| `BACKEND_CORS_ORIGINS`  | `http://localhost:5173`   | Comma-separated CORS origins        |

## Adding future tabs (Goal Pose, SLAM Map)

**Backend** — No changes needed.  Pass the correct `msg_type` string and `data`
dict to `POST /api/publish`.  `ros_messages.serialize()` is fully generic.

**Frontend** — In `App.tsx`:
  1. Set `disabled: false` on the relevant tab.
  2. Import and return your new tab component in `renderTab()`.
  3. Optionally add new API helpers in `lib/api.ts` if you need new endpoints.
