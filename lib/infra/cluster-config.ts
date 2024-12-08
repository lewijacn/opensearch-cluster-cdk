export interface ClusterConfig {
    getConfig(clusterName: string,
              isSingleNode: boolean,
              stackName: string,
              managerNodeCount: number,
              nodeType?: string,
              additionalConfig?: string): string;
}