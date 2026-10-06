# 1. Add the Eclipse Zenoh keyring
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.eclipse.org/zenoh/debian-repo/zenoh-public-key | sudo gpg --dearmor -o /etc/apt/keyrings/zenoh-public-key.gpg

# 2. Add the repository
echo "deb [signed-by=/etc/apt/keyrings/zenoh-public-key.gpg] https://download.eclipse.org/zenoh/debian-repo/ /" | sudo tee /etc/apt/sources.list.d/zenoh.list

# 3. Update and install
sudo apt update
sudo apt install -y zenoh-bridge-ros2dds
																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																																									
