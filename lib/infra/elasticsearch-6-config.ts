import {dump} from "js-yaml";
import {ClusterConfig} from "./cluster-config";
import {InitCommand} from "aws-cdk-lib/aws-ec2";

const nodeRoleSettings: { [key: string]: object } = {
    manager: {
        'node.master': true,
        'node.data': false,
        'node.ingest': false
    },
    data: {
        'node.master': false,
        'node.data': true,
        'node.ingest': true
    },
    seedManager: {
        'node.name': 'seed',
        'node.master': true,
        'node.data': false,
        'node.ingest': false
    },
    seedData: {
        'node.name': 'seed',
        'node.master': false,
        'node.data': true,
        'node.ingest': true
    },
    client: {
        'node.name': 'client-node',
        'node.master': false,
        'node.data': false,
        'node.ingest': false
    },
    ml: {
        'node.name': 'ml-node',
        'node.master': false,
        'node.data': false,
        'node.ingest': false,
        'node.ml': true
    }
}

export class Elasticsearch6Config implements ClusterConfig {
    version: string;

    constructor() {
        this.version = "ES_6";
    }

    getJavaInitElement() {
        return InitCommand.shellCommand('set -ex;sudo amazon-linux-extras install corretto8 -y')
    }

    getSingleNodeBaseConfig(clusterName: string) {
        return {
            'cluster.name': clusterName,
            'network.host': 0,
            'http.port': 9200,
            'discovery.type': 'single-node'
        }
    }

    getMultiNodeBaseConfig(clusterName: string, stackName: string, managerNodeCount: number) {
        // https://www.elastic.co/guide/en/elasticsearch/reference/6.8/modules-node.html#split-brain
        const minMasterNodes = Math.trunc(managerNodeCount / 2) + 1
        return {
            'cluster.name': clusterName,
            'network.host': 0,
            'discovery.zen.hosts_provider': 'ec2',
            'discovery.zen.minimum_master_nodes': minMasterNodes,
            // use discovery-ec2 to find manager nodes by querying IMDS
            'discovery.ec2.tag.Name': `${stackName}/seedNodeAsg,${stackName}/managerNodeAsg`
        }
    }

    getConfig(clusterName: string, isSingleNode: boolean, stackName: string, managerNodeCount: number, nodeType?: string, additionalConfig?: string): string {
        let completeConfigDict = isSingleNode ? this.getSingleNodeBaseConfig(clusterName) : this.getMultiNodeBaseConfig(clusterName, stackName, managerNodeCount)
        if (nodeType) {
            const nodeTypeDict = nodeRoleSettings[nodeType]
            if (!nodeTypeDict) {
                throw new Error(`Unknown node type provided when retrieving elasticsearch config: ${nodeType}`)
            }
            completeConfigDict = {...completeConfigDict, ...nodeTypeDict}
        }
        let configString = dump(completeConfigDict).toString()
        if (additionalConfig) {
            configString = `${configString}\n${additionalConfig}`
        }
        return configString
    }

}