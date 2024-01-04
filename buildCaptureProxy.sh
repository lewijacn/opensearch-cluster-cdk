#!/bin/bash

# Example usage: ./buildCaptureProxy.sh https://github.com/opensearch-project/opensearch-migrations.git main

git_http_url=$1
branch=$2
export JAVA_HOME=/home/ec2-user/elasticsearch/jdk

if [ -d "/home/ec2-user/capture-proxy/trafficCaptureProxyServer" ]; then
  # TODO allow option to force a build
  echo "The trafficCaptureProxyServer directory already exists, skipping build."
  exit 1
fi

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
./gradlew build -p trafficCaptureProxyServer

cd /home/ec2-user/capture-proxy || exit
cp /home/ec2-user/capture-proxy/opensearch-migrations/TrafficCapture/trafficCaptureProxyServer/build/distributions/trafficCaptureProxyServer.zip /home/ec2-user/capture-proxy
unzip trafficCaptureProxyServer.zip
rm trafficCaptureProxyServer.zip