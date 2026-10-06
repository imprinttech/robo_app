# Zenoh ROS 2 DDS Bridges Configuration

This directory contains configuration files for running `zenoh-bridge-ros2dds` instances for ROS 2 DDS communication with the web dashboard.

## Bridge Configurations

| Bridge | Config File | REST Port | Zenoh Listen Port | Nodename | Allowance |
|---|---|---|---|---|---|
| **Topics** | `zenoh_topics.json5` | `7777` | `7447` | `zenoh_bridge_topic_ros2dds` | Publishers & Subscribers (`.*`) |
| **Services** | `zenoh_services.json5` | `8888` | `7448` | `zenoh_bridge_service` | Service Servers & Clients (`.*`) |
| **Actions** | `zenoh_actions.json5` | `9999` | `7449` | `zenoh_bridge_action` | Action Servers & Clients (`.*`) |

> **Note:** All bridges connect to ROS 2 domain `88` (`ROS_DOMAIN_ID=88`).

---

## Running the Bridges

Make sure `zenoh-bridge-ros2dds` is installed on your system.

### Option 1: Run in Separate Terminals

#### 1. Topics Bridge (Terminal 1)
```bash
cd warehouse-robot-app/zenoh_scripts
zenoh-bridge-ros2dds -c zenoh_topics.json5
```

#### 2. Services Bridge (Terminal 2)
```bash
cd warehouse-robot-app/zenoh_scripts
zenoh-bridge-ros2dds -c zenoh_services.json5
```

#### 3. Actions Bridge (Terminal 3)
```bash
cd warehouse-robot-app/zenoh_scripts
zenoh-bridge-ros2dds -c zenoh_actions.json5
```

---

### Option 2: Run All Bridges in Background (Single Terminal)

```bash
cd warehouse-robot-app/zenoh_scripts
zenoh-bridge-ros2dds -c zenoh_topics.json5 &
zenoh-bridge-ros2dds -c zenoh_services.json5 &
zenoh-bridge-ros2dds -c zenoh_actions.json5 &
```

To stop all background bridge instances:
```bash
killall zenoh-bridge-ros2dds
```

---

## Testing / Verification

Check if the REST endpoints are reachable:

```bash
# Topics REST API (port 7777)
curl -s http://localhost:7777/@/router/local/version

# Services REST API (port 8888)
curl -s http://localhost:8888/@/router/local/version

# Actions REST API (port 9999)
curl -s http://localhost:9999/@/router/local/version
```
