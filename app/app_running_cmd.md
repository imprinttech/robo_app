# Terminal A — backend
source /opt/ros/jazzy/setup.bash && source ~/AGV/sim_ws/install/setup.bash
cd ~/AGV/sim_ws/warehouse-robot-app/backend
~/.local/bin/uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload

# Terminal B — frontend (npm is now installed)
cd ~/AGV/sim_ws/warehouse-robot-app/frontend
npm install
npm run dev

