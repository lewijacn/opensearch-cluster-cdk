/* Copyright OpenSearch Contributors
SPDX-License-Identifier: Apache-2.0

The OpenSearch Contributors require contributions made to
this file be licensed under the Apache-2.0 license or a
compatible open source license. */

import { Stack, StackProps } from 'aws-cdk-lib';
import { EbsDeviceVolumeType } from 'aws-cdk-lib/aws-autoscaling';
import {
  AmazonLinuxCpuType,
  IVpc,
  InstanceType,
  SecurityGroup,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { dump } from 'js-yaml';
import { readFileSync } from 'fs';
import { InfraStack } from './infra/infra-stack';
import { NetworkStack } from './networking/vpc-stack';
import {
  arm64Ec2InstanceType,
  getArm64InstanceTypes,
  getVolumeType,
  getX64InstanceTypes,
  x64Ec2InstanceType,
} from './opensearch-config/node-config';

enum cpuArchEnum{
    X64='x64',
    ARM64='arm64'
}

const getContextJSONFromFile = (contextFile: string|undefined, contextId: string|undefined) => {
  if (contextFile && contextId) {
    const fileString = readFileSync(contextFile, 'utf-8');
    const fileJSON = JSON.parse(fileString);
    const contextBlock = fileJSON[contextId];
    if (!contextBlock) {
      throw new Error(`No CDK context block found for contextId '${contextId}' in file ${contextFile}`);
    }
    return contextBlock;
  }
  return undefined;
};

const getContext = (scope: Construct, contextJSON: string|undefined, optionName: string, enforceString = true) => {
  if (contextJSON === undefined) {
    return enforceString ? `${scope.node.tryGetContext(optionName)}` : scope.node.tryGetContext(optionName);
  }
  // @ts-ignore
  return enforceString ? `${contextJSON[optionName]}` : contextJSON[optionName];
};

const getInstanceType = (instanceType: string, arch: string) => {
  if (arch === 'x64') {
    if (instanceType !== 'undefined') {
      return getX64InstanceTypes(instanceType);
    }
    return getX64InstanceTypes('r5.xlarge');
  }
  if (instanceType !== 'undefined') {
    return getArm64InstanceTypes(instanceType);
  }
  return getArm64InstanceTypes('r6g.xlarge');
};

export class OsClusterEntrypoint {
    public stacks: Stack[] = [];

    public vpc: IVpc;

    public securityGroup = SecurityGroup;

    constructor(scope: Construct, props: StackProps) {
      let instanceCpuType: AmazonLinuxCpuType;
      let managerCount: number;
      let dataCount: number;
      let clientCount: number;
      let ingestCount: number;
      let mlCount: number;
      let zoneCount: number;
      let infraStackName: string;
      let dataNodeStorage: number;
      let mlNodeStorage: number;
      let ymlConfig: string = 'undefined';
      let osdYmlConfig: string = 'undefined';
      let dataEc2InstanceType: InstanceType;
      let mlEc2InstanceType: InstanceType;
      let volumeType: EbsDeviceVolumeType;

      const contextFile = scope.node.tryGetContext('contextFile');
      const contextId = scope.node.tryGetContext('contextId');
      if ((contextFile && !contextId) || (!contextFile && contextId)) {
        throw new Error('The following context parameters are all required when in use: [contextFile, contextId]');
      }
      const jsonFileContext = getContextJSONFromFile(contextFile, contextId);

      const x64InstanceTypes: string[] = Object.keys(x64Ec2InstanceType);
      const arm64InstanceTypes: string[] = Object.keys(arm64Ec2InstanceType);
      const vpcId: string = getContext(scope, jsonFileContext, 'vpcId', false);
      const securityGroupId = getContext(scope, jsonFileContext, 'securityGroupId', false);
      const cidrRange = getContext(scope, jsonFileContext, 'cidr', false);
      const restrictServerAccessTo = getContext(scope, jsonFileContext, 'restrictServerAccessTo', false);
      const serverAccessType = getContext(scope, jsonFileContext, 'serverAccessType', false);

      const distVersion = getContext(scope, jsonFileContext, 'distVersion');
      if (distVersion.toString() === 'undefined') {
        throw new Error('Please provide the OS distribution version');
      }

      const securityDisabled = getContext(scope, jsonFileContext, 'securityDisabled');
      if (securityDisabled !== 'true' && securityDisabled !== 'false') {
        throw new Error('securityEnabled parameter is required to be set as - true or false');
      }
      const security = securityDisabled === 'true';

      const minDistribution = getContext(scope, jsonFileContext, 'minDistribution');
      if (minDistribution !== 'true' && minDistribution !== 'false') {
        throw new Error('minDistribution parameter is required to be set as - true or false');
      }
      const minDist = minDistribution === 'true';

      const distributionUrl = getContext(scope, jsonFileContext, 'distributionUrl');
      if (distributionUrl.toString() === 'undefined') {
        throw new Error('distributionUrl parameter is required. Please provide the artifact url to download');
      }

      const captureProxyEnabled = getContext(scope, jsonFileContext, 'captureProxyEnabled');
      if (captureProxyEnabled !== 'true' && captureProxyEnabled !== 'false') {
        throw new Error('captureProxyEnabled parameter is required to be set as - true or false');
      }
      const captureProxy = captureProxyEnabled === 'true';
      const captureProxyTarUrl = getContext(scope, jsonFileContext, 'captureProxyTarUrl', false);

      const dashboardUrl = getContext(scope, jsonFileContext, 'dashboardsUrl');

      const cpuArch = getContext(scope, jsonFileContext, 'cpuArch');

      const dataInstanceType = getContext(scope, jsonFileContext, 'dataInstanceType');
      const mlInstanceType = getContext(scope, jsonFileContext, 'mlInstanceType');

      if (cpuArch.toString() === 'undefined') {
        throw new Error('cpuArch parameter is required. The provided value should be either x64 or arm64, any other value is invalid');
        // @ts-ignore
      } else if (Object.values(cpuArchEnum).includes(cpuArch.toString())) {
        if (cpuArch.toString() === cpuArchEnum.X64) {
          instanceCpuType = AmazonLinuxCpuType.X86_64;
          dataEc2InstanceType = getInstanceType(dataInstanceType, cpuArch.toString());
          mlEc2InstanceType = getInstanceType(mlInstanceType, cpuArch.toString());
        } else {
          instanceCpuType = AmazonLinuxCpuType.ARM_64;
          dataEc2InstanceType = getInstanceType(dataInstanceType, cpuArch.toString());
          mlEc2InstanceType = getInstanceType(mlInstanceType, cpuArch.toString());
        }
      } else {
        throw new Error('Please provide a valid cpu architecture. The valid value can be either x64 or arm64');
      }

      const singleNodeCluster = getContext(scope, jsonFileContext, 'singleNodeCluster');
      const isSingleNode = singleNodeCluster === 'true';

      const managerNodeCount = getContext(scope, jsonFileContext, 'managerNodeCount');
      if (managerNodeCount.toString() === 'undefined') {
        managerCount = 3;
      } else {
        managerCount = parseInt(managerNodeCount, 10);
      }

      const dataNodeCount = getContext(scope, jsonFileContext, 'dataNodeCount');
      if (dataNodeCount.toString() === 'undefined') {
        dataCount = 2;
      } else {
        dataCount = parseInt(dataNodeCount, 10);
      }

      const clientNodeCount = getContext(scope, jsonFileContext, 'clientNodeCount');
      if (clientNodeCount.toString() === 'undefined') {
        clientCount = 0;
      } else {
        clientCount = parseInt(clientNodeCount, 10);
      }

      const ingestNodeCount = getContext(scope, jsonFileContext, 'ingestNodeCount');
      if (ingestNodeCount.toString() === 'undefined') {
        ingestCount = 0;
      } else {
        ingestCount = parseInt(clientNodeCount, 10);
      }

      const mlNodeCount = getContext(scope, jsonFileContext, 'mlNodeCount');
      if (mlNodeCount.toString() === 'undefined') {
        mlCount = 0;
      } else {
        mlCount = parseInt(mlNodeCount, 10);
      }

      const dataSize = getContext(scope, jsonFileContext, 'dataNodeStorage');
      if (dataSize === 'undefined') {
        dataNodeStorage = 100;
      } else {
        dataNodeStorage = parseInt(dataSize, 10);
      }

      const inputVolumeType = getContext(scope, jsonFileContext, 'storageVolumeType');
      if (inputVolumeType.toString() === 'undefined') {
        // use gp2 volume by default
        volumeType = getVolumeType('gp2');
      } else {
        volumeType = getVolumeType(inputVolumeType);
      }

      const mlSize = getContext(scope, jsonFileContext, 'mlNodeStorage');
      if (mlSize === 'undefined') {
        mlNodeStorage = 100;
      } else {
        mlNodeStorage = parseInt(mlSize, 10);
      }

      const jvmSysProps = getContext(scope, jsonFileContext, 'jvmSysProps');

      const osConfig = getContext(scope, jsonFileContext, 'additionalConfig');
      if (osConfig.toString() !== 'undefined') {
        try {
          const jsonObj = JSON.parse(osConfig);
          ymlConfig = dump(jsonObj);
        } catch (e) {
          throw new Error(`Encountered following error while parsing additionalConfig json parameter: ${e}`);
        }
      }

      const osdConfig = getContext(scope, jsonFileContext, 'additionalOsdConfig');
      if (osdConfig.toString() !== 'undefined') {
        try {
          const jsonObj = JSON.parse(osdConfig);
          osdYmlConfig = dump(jsonObj);
        } catch (e) {
          throw new Error(`Encountered following error while parsing additionalOsdConfig json parameter: ${e}`);
        }
      }

      const suffix = getContext(scope, jsonFileContext, 'suffix');
      const networkStackSuffix = getContext(scope, jsonFileContext, 'networkStackSuffix');

      const use50heap = getContext(scope, jsonFileContext, 'use50PercentHeap');
      const use50PercentHeap = use50heap === 'true';

      const nlbScheme = getContext(scope, jsonFileContext, 'isInternal');
      const isInternal = nlbScheme === 'true';

      const remoteStore = getContext(scope, jsonFileContext, 'enableRemoteStore');
      const enableRemoteStore = remoteStore === 'true';

      const customRoleArn = getContext(scope, jsonFileContext, 'customRoleArn');

      const networkAvailabilityZones = getContext(scope, jsonFileContext, 'networkAvailabilityZones');
      if (networkAvailabilityZones === 'undefined') {
        zoneCount = 3;
      } else {
        zoneCount = parseInt(networkAvailabilityZones, 10);
      }

      let networkStackName = 'opensearch-network-stack';
      if (networkStackSuffix !== 'undefined') {
        networkStackName = `opensearch-network-stack-${networkStackSuffix}`;
      }

      const network = new NetworkStack(scope, networkStackName, {
        cidrBlock: cidrRange,
        maxAzs: zoneCount,
        vpcId,
        securityGroupId,
        serverAccessType,
        restrictServerAccessTo,
        ...props,
      });

      this.vpc = network.vpc;
      // @ts-ignore
      this.securityGroup = network.osSecurityGroup;

      this.stacks.push(network);

      if (suffix === 'undefined') {
        infraStackName = 'opensearch-infra-stack';
      } else {
        infraStackName = `opensearch-infra-stack-${suffix}`;
      }

      // @ts-ignore
      const infraStack = new InfraStack(scope, infraStackName, {
        vpc: this.vpc,
        securityDisabled: security,
        opensearchVersion: distVersion,
        clientNodeCount: clientCount,
        cpuArch,
        cpuType: instanceCpuType,
        dataEc2InstanceType,
        mlEc2InstanceType,
        dashboardsUrl: dashboardUrl,
        dataNodeCount: dataCount,
        distributionUrl,
        captureProxyEnabled: captureProxy,
        captureProxyTarUrl,
        ingestNodeCount: ingestCount,
        managerNodeCount: managerCount,
        minDistribution: minDist,
        mlNodeCount: mlCount,
        // @ts-ignore
        securityGroup: this.securityGroup,
        singleNodeCluster: isSingleNode,
        dataNodeStorage,
        mlNodeStorage,
        jvmSysPropsString: jvmSysProps,
        additionalConfig: ymlConfig,
        additionalOsdConfig: osdYmlConfig,
        use50PercentHeap,
        isInternal,
        enableRemoteStore,
        storageVolumeType: volumeType,
        customRoleArn,
        ...props,
      });

      infraStack.addDependency(network);

      this.stacks.push(infraStack);
    }
}
