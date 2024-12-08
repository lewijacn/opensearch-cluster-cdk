import {dump} from "js-yaml";
import {ClusterConfig} from "./cluster-config";

const nodeRoleSettings: { [key: string]: object } = {
    manager: {
        'node.roles': ['master']
    },
    data: {
        'node.roles': ['data', 'ingest']
    },
    seedManager: {
        'node.name': 'seed',
        'node.roles': ['master'],
    },
    seedData: {
        'node.name': 'seed',
        'node.roles': ['master', 'data'],
    },
    client: {
        'node.name': 'client-node',
        'node.roles': [],
    },
    ml: {
        'node.name': 'ml-node',
        'node.roles': ['ml'],
    }
}

export class Elasticsearch7Config implements ClusterConfig {
    version: string;

    constructor() {
        this.version = "ES_7";
    }

    getSingleNodeBaseConfig(clusterName: string) {
        return {
            'cluster.name': clusterName,
            'network.host': 0,
            'http.port': 9200,
            'discovery.type': 'single-node'
        }
    }

    getMultiNodeBaseConfig(clusterName: string, stackName: string) {
        return {
            'cluster.name': clusterName,
            'cluster.initial_master_nodes': ["seed"],
            'discovery.seed_providers': 'ec2',
            'network.host': 0,
            // use discovery-ec2 to find manager nodes by querying IMDS
            'discovery.ec2.tag.Name': `${stackName}/seedNodeAsg,${stackName}/managerNodeAsg`
        }
    }

    getConfig(clusterName: string, isSingleNode: boolean, stackName: string, managerNodeCount: number, nodeType?: string, additionalConfig?: string): string {
        let completeConfigDict = isSingleNode ? this.getSingleNodeBaseConfig(clusterName) : this.getMultiNodeBaseConfig(clusterName, stackName)
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