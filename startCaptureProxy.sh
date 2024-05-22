#!/bin/bash

usage() {
  echo ""
  echo "Restarts ES node with port 19200 and start capture proxy on port 9200"
  echo ""
  echo "Usage: "
  echo "  ./startCaptureProxy.sh <--kafka-endpoints STRING> <--git-url STRING> <--git-branch STRING>"
  echo ""
  echo "Options:"
  echo "  --kafka-endpoints                     Kafka broker endpoints that captured traffic will be sent to, e.g. 'broker1:9092,broker2:9092'."
  echo "  --git-url                             The Github http url used to pull the trafficCaptureProxyServer for building, e.g. 'https://github.com/opensearch-project/opensearch-migrations.git'."
  echo "  --git-branch                          The Github branch associated with the 'git-url' to pull from, e.g. 'main'."
  echo "  --stage                               The deployment stage used for the associated OpenSearch Migrations CDK deployment"
  echo ""
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --kafka-endpoints)
      KAFKA_ENDPOINTS="$2"
      shift # past argument
      shift # past value
      ;;
    --git-url)
      GIT_URL="$2"
      shift # past argument
      shift # past value
      ;;
    --git-branch)
      GIT_BRANCH="$2"
      shift # past argument
      shift # past value
      ;;
    --stage)
      STAGE="$2"
      shift # past argument
      shift # past value
      ;;
    -h|--help)
      usage
      ;;
    -*)
      echo "Unknown option $1"
      usage
      ;;
    *)
      shift # past argument
      ;;
  esac
done

if [ -z "$KAFKA_ENDPOINTS" ] ||  [ -z "$GIT_URL" ] || [ -z "$GIT_BRANCH" ] || [ -z "$STAGE" ]; then
  echo "At least one required argument is missing [--kafka-endpoints, --git-url, --git-branch, --stage]"
  exit 1
fi
# Allow @ to be used instead of ',' for cases where ',' would disrupt formatting of arguments, i.e. AWS SSM commands
KAFKA_ENDPOINTS=$(echo "$KAFKA_ENDPOINTS" | tr '@' ',')

./buildCaptureProxy.sh "$GIT_URL" "$GIT_BRANCH"

set -e
es_pid=$(pgrep -f "bin/elasticsearch" || echo "")
if [ -z "$es_pid" ]; then
  echo "No running Elasticsearch process detected"
else
  echo "Elasticsearch process PID: $es_pid"
fi

capture_pid=$(pgrep -f "trafficCaptureProxyServer" || echo "")
if [ -z "$capture_pid" ]; then
  echo "No running Capture Proxy process detected"
else
  echo "Capture Proxy process PID: $capture_pid"
fi

if [ -n "$es_pid" ] && [ -n "$capture_pid" ]; then
  echo "Both Elasticsearch and Capture Proxy processes are running, no actions will be performed."
  exit 0
fi

cd /home/ec2-user/elasticsearch/config
es_http_port_entry=$(cat elasticsearch.yml | grep "http.port" || echo "")
es_needs_restart=false
if [ -z "$es_http_port_entry" ]; then
  echo "Appending 'http.port: 19200' to elasticsearch.yml"
  echo "http.port: 19200" >> elasticsearch.yml
  es_needs_restart=true
elif [[ "$es_http_port_entry" == "http.port: 19200" ]]; then
  echo "Correct http.port already exists: $es_http_port_entry"
else
  echo "Replacing existing $es_http_port_entry"
  sed -i 's/http.port: [0-9]\+/http.port: 19200/' elasticsearch.yml
  es_needs_restart=true
fi

cd /home/ec2-user/elasticsearch
if [ -z "$es_pid" ]; then
  echo "Starting Elasticsearch process"
  # Running nohup from an AWS SSM command without redirecting the I/O will causing hanging: https://en.wikipedia.org/wiki/Nohup#Overcoming_hanging
  sudo -u ec2-user nohup ./bin/elasticsearch >/dev/null 2>&1 &
elif [ "$es_needs_restart" = true ]; then
  echo "Restarting Elasticsearch process"
  kill "$es_pid"
  # Running nohup from an AWS SSM command without redirecting the I/O will causing hanging: https://en.wikipedia.org/wiki/Nohup#Overcoming_hanging
  sudo -u ec2-user nohup ./bin/elasticsearch >/dev/null 2>&1 &
fi

export JAVA_HOME=/home/ec2-user/elasticsearch/jdk
cd /home/ec2-user/capture-proxy/trafficCaptureProxyServer/bin
if [ -n "$capture_pid" ]; then
  echo "Stopping running Capture Proxy process"
  kill "$capture_pid"
fi
echo "Starting Capture Proxy process"
# Running nohup from an AWS SSM command without redirecting the I/O will causing hanging: https://en.wikipedia.org/wiki/Nohup#Overcoming_hanging
# Suppressing incoming traffic with User-Agent header containing 'elastic-java/7.10.0' to prevent capturing requests from Data Prepper requests during a Fetch Migration
sudo -u ec2-user nohup ./trafficCaptureProxyServer --kafkaConnection "$KAFKA_ENDPOINTS" --destinationUri http://localhost:19200 --suppressCaptureForHeaderMatch "user-agent" ".*elastic-java/7.17.0.*"  --listenPort 9200 --enableMSKAuth --insecureDestination >/dev/null 2>&1 &

sleep 5
capture_pid_verify=$(pgrep -f "trafficCaptureProxyServer" || echo "")
if [ -z "$capture_pid_verify" ]; then
  echo "Capture Proxy appears to have encountered issue on startup"
  if [ -e nohup.out ]; then
    echo "Capture Proxy final log statements: "
    tail -n 50 nohup.out
  fi
fi
echo "Completed startCaptureProxy.sh"
