#!/bin/bash

set -e

usage() {
  echo ""
  echo "Restarts ES node with port 19200 and start capture proxy on port 9200"
  echo ""
  echo "Usage: "
  echo "  ./startCaptureProxy.sh <--kafka-endpoints STRING>"
  echo ""
  echo "Options:"
  echo "  --kafka-endpoints                     Kafka broker endpoints that captured traffic will be sent to e.g. 'broker1:9092,broker2:9092'."
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
es_http_port_entry=$(cat elasticsearch.yml | grep "http.port")
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
  sudo -u ec2-user nohup ./bin/elasticsearch &
elif [ "$es_needs_restart" = true ]; then
  echo "Restarting Elasticsearch process"
  kill "$es_pid"
  sudo -u ec2-user nohup ./bin/elasticsearch &
fi

export JAVA_HOME=/home/ec2-user/elasticsearch/jdk
cd /home/ec2-user/capture-proxy/trafficCaptureProxyServer/bin
if [ -n "$capture_pid" ]; then
  echo "Stopping running Capture Proxy process"
  kill "$capture_pid"
fi
echo "Starting Capture Proxy process"
nohup ./trafficCaptureProxyServer --kafkaConnection "$KAFKA_ENDPOINTS" --destinationUri http://localhost:19200 --listenPort 9200 --enableMSKAuth --insecureDestination &

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