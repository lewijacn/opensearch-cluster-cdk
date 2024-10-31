#!/bin/bash

# Example usage: ./buildCaptureProxy.sh https://github.com/opensearch-project/opensearch-migrations.git main

git_http_url=$1
branch=$2
# This must be match Java requirement from Migration Assistant (Java 11 currently)
#export JAVA_HOME=/home/ec2-user/elasticsearch/jdk

mkdir -p /home/ec2-user/capture-proxy/opensearch-migrations
cd /home/ec2-user/capture-proxy/opensearch-migrations || exit
git init
remote_exists=$(git remote -v | grep origin)
if [ -z "${remote_exists}" ]; then
  echo "No remote detected, adding 'origin'"
  git remote add -f origin "$git_http_url"
else
  echo "Existing 'origin' remote detected, updating to $git_http_url"
  git remote set-url origin "$git_http_url"
fi

git pull origin "$branch"
./gradlew TrafficCapture:trafficCaptureProxyServer:build -x test

# Calculate the age of the distribution file in seconds
dist_file=$(ls /home/ec2-user/capture-proxy/opensearch-migrations/TrafficCapture/trafficCaptureProxyServer/build/distributions/trafficCaptureProxyServer*.zip)
dist_age_seconds=$(( $(date +%s) - $(stat -L --format %Y "$dist_file") ))

echo "Capture Proxy distribution was created $dist_age_seconds seconds ago"
proxy_needs_restart=false
if [ "$dist_age_seconds" -lt 60 ]; then
   echo "Capture Proxy required an updated distribution. Stopping Capture Proxy, if running, for a restart"
   proxy_needs_restart=true
fi

if [ "$proxy_needs_restart" = true ]; then
  capture_pid=$(pgrep -f "trafficCaptureProxyServer" || echo "")
  if [ -n "$capture_pid" ]; then
    echo "Stopping running Capture Proxy process"
    kill "$capture_pid"
  fi
  if [ -d "/home/ec2-user/capture-proxy/trafficCaptureProxyServer" ]; then
    echo "Removing existing trafficCaptureProxyServer directory."
    rm -rf "/home/ec2-user/capture-proxy/trafficCaptureProxyServer"
  fi

  cd /home/ec2-user/capture-proxy || exit
  cp "$dist_file" /home/ec2-user/capture-proxy/trafficCaptureProxyServer.zip
  unzip -o trafficCaptureProxyServer.zip
  # Move the file, matching any version in the name
  rm trafficCaptureProxyServer.zip
  mv trafficCaptureProxyServer* ./trafficCaptureProxyServer
fi
