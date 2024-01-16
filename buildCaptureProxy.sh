#!/bin/bash

# Example usage: ./buildCaptureProxy.sh https://github.com/opensearch-project/opensearch-migrations.git main

git_http_url=$1
branch=$2
export JAVA_HOME=/home/ec2-user/elasticsearch/jdk

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

git config core.sparseCheckout true
# Check file exists and contains sparse-checkout
if test -f .git/info/sparse-checkout; then
  sparse_entry=$(cat .git/info/sparse-checkout | grep "/TrafficCapture")
  if [ -z "${sparse_entry}" ]; then
    echo "No '/TrafficCapture' entry in '.git/info/sparse-checkout' file detected, will attempt to add"
    git remote add -f origin "$git_http_url"
  else
    echo "Have detected '/TrafficCapture' entry in '.git/info/sparse-checkout' file, no changes needed"
  fi
else
  echo "File '.git/info/sparse-checkout' not found, will attempt to create"
  echo "/TrafficCapture" >> .git/info/sparse-checkout
fi

git pull origin "$branch"
cd TrafficCapture || exit
./gradlew build -p trafficCaptureProxyServer -x test

dist_age_seconds=$(( `date +%s` - `stat -L --format %Y "/home/ec2-user/capture-proxy/opensearch-migrations/TrafficCapture/trafficCaptureProxyServer/build/distributions/trafficCaptureProxyServer.zip"` ))
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
  cp /home/ec2-user/capture-proxy/opensearch-migrations/TrafficCapture/trafficCaptureProxyServer/build/distributions/trafficCaptureProxyServer.zip /home/ec2-user/capture-proxy
  unzip -o trafficCaptureProxyServer.zip
  rm trafficCaptureProxyServer.zip
fi