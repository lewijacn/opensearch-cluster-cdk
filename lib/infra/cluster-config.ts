import {InitElement} from "aws-cdk-lib/aws-ec2/lib/cfn-init-elements";

export interface ClusterConfig {
    getConfig(clusterName: string,
              isSingleNode: boolean,
              stackName: string,
              managerNodeCount: number,
              nodeType?: string,
              additionalConfig?: string): string;

    getJavaInitElement(): InitElement;
}