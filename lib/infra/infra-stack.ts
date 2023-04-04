/* Copyright OpenSearch Contributors
SPDX-License-Identifier: Apache-2.0

The OpenSearch Contributors require contributions made to
this file be licensed under the Apache-2.0 license or a
compatible open source license. */

import {
  AmazonLinuxCpuType,
  AmazonLinuxGeneration,
  CloudFormationInit,
  InitCommand,
  InitElement,
  InitPackage,
  InstanceClass,
  InstanceSize,
  InstanceType,
  ISecurityGroup,
  IVpc,
  MachineImage,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AutoScalingGroup, BlockDeviceVolume, Signals } from 'aws-cdk-lib/aws-autoscaling';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  CfnOutput, RemovalPolicy, Stack, StackProps, Tags,
} from 'aws-cdk-lib';
import { NetworkListener, NetworkLoadBalancer, Protocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { join } from 'path';
import { readFileSync } from 'fs';
import { dump, load } from 'js-yaml';
import { CloudwatchAgent } from '../cloudwatch/cloudwatch-agent';
import { nodeConfig } from '../opensearch-config/node-config';

export interface infraProps extends StackProps{
    readonly vpc: IVpc,
    readonly securityGroup: ISecurityGroup,
    readonly opensearchVersion: string,
    readonly cpuArch: string,
    readonly cpuType: AmazonLinuxCpuType,
    readonly securityDisabled: boolean,
    readonly minDistribution: boolean,
    readonly distributionUrl: string,
    readonly dashboardsUrl: string,
    readonly singleNodeCluster: boolean,
    readonly managerNodeCount: number,
    readonly dataNodeCount: number,
    readonly ingestNodeCount: number,
    readonly clientNodeCount: number,
    readonly mlNodeCount: number,
    readonly jvmSysPropsString?: string
}

export class InfraStack extends Stack {
  constructor(scope: Stack, id: string, props: infraProps) {
    super(scope, id, props);
    let opensearchListener: NetworkListener;
    let dashboardsListener: NetworkListener;
    let managerAsgCapacity: number;
    let dataAsgCapacity: number;
    let clientNodeAsg: AutoScalingGroup;
    let seedConfig: string;
    let hostType: InstanceType;

    const clusterLogGroup = new LogGroup(this, 'opensearchLogGroup', {
      logGroupName: 'opensearchLogGroup/opensearch.log',
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const loggingPluginLogGroup = new LogGroup(this, 'loggingPluginLogGroup', {
      logGroupName: 'opensearchLogGroup/loggingPlugin.log',
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const instanceRole = new Role(this, 'instanceRole', {
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ReadOnlyAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
    });

    const ec2InstanceType = (props.cpuType === AmazonLinuxCpuType.X86_64)
      ? InstanceType.of(InstanceClass.C5, InstanceSize.XLARGE) : InstanceType.of(InstanceClass.C6G, InstanceSize.XLARGE);

    if (props.singleNodeCluster) {
      console.log('Single node value is true, creating single node configurations');
      const singleDataNodeAsg = new AutoScalingGroup(this, 'dataNodeAsg', {
        vpc: props.vpc,
        instanceType: ec2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: instanceRole,
        maxCapacity: 1,
        minCapacity: 1,
        desiredCapacity: 1,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
        }],
        init: InfraStack.constructCloudFormationInit(this, clusterLogGroup, props),
        initOptions: {
          ignoreFailures: false,
        },
        signals: Signals.waitForAll(),
      });
      clientNodeAsg = singleDataNodeAsg;
      Tags.of(singleDataNodeAsg).add('role', 'client');
    } else {
      if (props.managerNodeCount > 0) {
        managerAsgCapacity = props.managerNodeCount - 1;
        dataAsgCapacity = props.dataNodeCount;
      } else {
        managerAsgCapacity = props.managerNodeCount;
        dataAsgCapacity = props.dataNodeCount - 1;
      }

      if (managerAsgCapacity > 0) {
        const managerNodeAsg = new AutoScalingGroup(this, 'managerNodeAsg', {
          vpc: props.vpc,
          instanceType: ec2InstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: instanceRole,
          maxCapacity: managerAsgCapacity,
          minCapacity: managerAsgCapacity,
          desiredCapacity: managerAsgCapacity,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
          }],
          init: InfraStack.constructCloudFormationInit(this, clusterLogGroup, props, 'manager'),
          initOptions: {
            ignoreFailures: false,
          },
          signals: Signals.waitForAll(),
        });
        Tags.of(managerNodeAsg).add('role', 'manager');

        seedConfig = 'seed-manager';
      } else {
        seedConfig = 'seed-data';
      }

      const seedNodeAsg = new AutoScalingGroup(this, 'seedNodeAsg', {
        vpc: props.vpc,
        instanceType: ec2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: instanceRole,
        maxCapacity: 1,
        minCapacity: 1,
        desiredCapacity: 1,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
        }],
        init: InfraStack.constructCloudFormationInit(this, clusterLogGroup, props, seedConfig),
        initOptions: {
          ignoreFailures: false,
        },
        signals: Signals.waitForAll(),
      });
      Tags.of(seedNodeAsg).add('role', 'manager');

      const dataNodeAsg = new AutoScalingGroup(this, 'dataNodeAsg', {
        vpc: props.vpc,
        instanceType: ec2InstanceType,
        machineImage: MachineImage.latestAmazonLinux({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
          cpuType: props.cpuType,
        }),
        role: instanceRole,
        maxCapacity: dataAsgCapacity,
        minCapacity: dataAsgCapacity,
        desiredCapacity: dataAsgCapacity,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroup: props.securityGroup,
        blockDevices: [{
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
        }],
        init: InfraStack.constructCloudFormationInit(this, clusterLogGroup, props, 'data'),
        initOptions: {
          ignoreFailures: false,
        },
        signals: Signals.waitForAll(),
      });
      Tags.of(dataNodeAsg).add('role', 'data');

      if (props.clientNodeCount === 0) {
        clientNodeAsg = dataNodeAsg;
      } else {
        clientNodeAsg = new AutoScalingGroup(this, 'clientNodeAsg', {
          vpc: props.vpc,
          instanceType: ec2InstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: instanceRole,
          maxCapacity: props.clientNodeCount,
          minCapacity: props.clientNodeCount,
          desiredCapacity: props.clientNodeCount,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
          }],
          init: InfraStack.constructCloudFormationInit(this, clusterLogGroup, props, 'client'),
          initOptions: {
            ignoreFailures: false,
          },
          signals: Signals.waitForAll(),
        });
        Tags.of(clientNodeAsg).add('cluster', 'test-stack');
      }

      Tags.of(clientNodeAsg).add('role', 'client');

      if (props.mlNodeCount > 0) {
        const mlNodeAsg = new AutoScalingGroup(this, 'mlNodeAsg', {
          vpc: props.vpc,
          instanceType: ec2InstanceType,
          machineImage: MachineImage.latestAmazonLinux({
            generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
            cpuType: props.cpuType,
          }),
          role: instanceRole,
          maxCapacity: props.mlNodeCount,
          minCapacity: props.mlNodeCount,
          desiredCapacity: props.mlNodeCount,
          vpcSubnets: {
            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          },
          securityGroup: props.securityGroup,
          blockDevices: [{
            deviceName: '/dev/xvda',
            volume: BlockDeviceVolume.ebs(50, { deleteOnTermination: true }),
          }],
          init: InfraStack.constructCloudFormationInit(this, clusterLogGroup, props, 'ml'),
          initOptions: {
            ignoreFailures: false,
          },
          signals: Signals.waitForAll(),
        });

        Tags.of(mlNodeAsg).add('role', 'ml-node');
      }
    }

    const alb = new NetworkLoadBalancer(this, 'publicNlb', {
      vpc: props.vpc,
      internetFacing: true,
    });

    if (!props.securityDisabled && !props.minDistribution) {
      opensearchListener = alb.addListener('opensearch', {
        port: 443,
        protocol: Protocol.TCP,
      });

      dashboardsListener = alb.addListener('dashboards', {
        port: 8443,
        protocol: Protocol.TCP,
      });
    } else {
      opensearchListener = alb.addListener('opensearch', {
        port: 80,
        protocol: Protocol.TCP,
      });

      dashboardsListener = alb.addListener('dashboards', {
        port: 8443,
        protocol: Protocol.TCP,
      });
    }

    opensearchListener.addTargets('opensearchTarget', {
      port: 9200,
      targets: [clientNodeAsg],
    });

    dashboardsListener.addTargets('dashboardsTarget', {
      port: 5601,
      targets: [clientNodeAsg],
    });

    new CfnOutput(this, 'loadbalancer-url', {
      value: alb.loadBalancerDnsName,
      exportName: 'Loadbalancer-URL',
    });
  }

  private static constructCloudFormationInit(scope: Stack, logGroup: LogGroup, props: infraProps, nodeType?: string): CloudFormationInit {
    if (props.distributionUrl.includes('opensearch')) {
      return CloudFormationInit.fromElements(...this.getCfnInitElementOpenSearch(scope, logGroup, props, nodeType));
    }
    if (props.distributionUrl.includes('elasticsearch')) {
      return CloudFormationInit.fromElements(...this.getCfnInitElementElasticsearch(scope, logGroup, props, nodeType));
    }
    throw new Error(`Provided distributionUrl: ${props.distributionUrl} was not detected to be an OS or ES OSS distribution`);
  }

  private static getCfnInitElementOpenSearch(scope: Stack, logGroup: LogGroup, props: infraProps, nodeType?: string): InitElement[] {
    const configFileDir = join(__dirname, '../opensearch-config');
    let opensearchConfig: string;

    const cfnInitConfig : InitElement[] = [
      InitPackage.yum('amazon-cloudwatch-agent'),
      CloudwatchAgent.asInitFile('/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
        {
          agent: {
            metrics_collection_interval: 60,
            logfile: '/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log',
            omit_hostname: true,
            debug: false,
          },
          metrics: {
            metrics_collected: {
              cpu: {
                measurement: [
                  // eslint-disable-next-line max-len
                  'usage_active', 'usage_guest', 'usage_guest_nice', 'usage_idle', 'usage_iowait', 'usage_irq', 'usage_nice', 'usage_softirq', 'usage_steal', 'usage_system', 'usage_user', 'time_active', 'time_iowait', 'time_system', 'time_user',
                ],
              },
              disk: {
                measurement: [
                  'free', 'total', 'used', 'used_percent', 'inodes_free', 'inodes_used', 'inodes_total',
                ],
              },
              diskio: {
                measurement: [
                  'reads', 'writes', 'read_bytes', 'write_bytes', 'read_time', 'write_time', 'io_time',
                ],
              },
              mem: {
                measurement: [
                  'active', 'available', 'available_percent', 'buffered', 'cached', 'free', 'inactive', 'total', 'used', 'used_percent',
                ],
              },
              net: {
                measurement: [
                  'bytes_sent', 'bytes_recv', 'drop_in', 'drop_out', 'err_in', 'err_out', 'packets_sent', 'packets_recv',
                ],
              },
            },
          },
          logs: {
            logs_collected: {
              files: {
                collect_list: [
                  {
                    file_path: `/home/ec2-user/opensearch/logs/${scope.stackName}-${scope.account}-${scope.region}.log`,
                    log_group_name: `${logGroup.logGroupName.toString()}`,
                    // eslint-disable-next-line no-template-curly-in-string
                    log_stream_name: '{instance_id}',
                    auto_removal: true,
                  },
                ],
              },
            },
            force_flush_interval: 5,
          },
        }),
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s'),
      InitCommand.shellCommand('set -ex; sudo echo "vm.max_map_count=262144" >> /etc/sysctl.conf;sudo sysctl -p'),
      InitCommand.shellCommand(`set -ex;mkdir opensearch; curl -L ${props.distributionUrl} -o opensearch.tar.gz;`
                + 'tar zxf opensearch.tar.gz -C opensearch --strip-components=1; chown -R ec2-user:ec2-user opensearch;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }),
      InitCommand.shellCommand(`set -ex;mkdir opensearch-dashboards; curl -L ${props.dashboardsUrl} -o opensearch-dashboards.tar.gz;`
          + 'tar zxf opensearch-dashboards.tar.gz -C opensearch-dashboards --strip-components=1; chown -R ec2-user:ec2-user opensearch-dashboards;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }),
      InitCommand.shellCommand('sleep 15'),
    ];

    cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;echo "server.host: 0.0.0.0" >> config/opensearch_dashboards.yml',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));

    // Add opensearch.yml config
    if (props.singleNodeCluster) {
      const fileContent: any = load(readFileSync(`${configFileDir}/single-node-base-config.yml`, 'utf-8'));

      fileContent['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;

      console.log(dump(fileContent).toString());
      opensearchConfig = dump(fileContent).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "${opensearchConfig}" > config/opensearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));
    } else {
      const baseConfig: any = load(readFileSync(`${configFileDir}/multi-node-base-config.yml`, 'utf-8'));

      baseConfig['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;
      const commonConfig = dump(baseConfig).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "${commonConfig}" > config/opensearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));

      if (nodeType != null) {
        const nodeTypeConfig = nodeConfig.get(nodeType);
        const nodeConfigData = dump(nodeTypeConfig).toString();
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd opensearch; echo "${nodeConfigData}" >> config/opensearch.yml`,
          {
            cwd: '/home/ec2-user',
          }));
      }

      if (props.distributionUrl.includes('ci.opensearch.org') || props.minDistribution) {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; echo "y"|sudo -u ec2-user bin/opensearch-plugin install '
            + `https://ci.opensearch.org/ci/dbc/distribution-build-opensearch/${props.opensearchVersion}/latest/linux/${props.cpuArch}`
            + `/tar/builds/opensearch/core-plugins/discovery-ec2-${props.opensearchVersion}.zip`, {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      } else {
        cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; echo "y"|sudo -u ec2-user bin/opensearch-plugin install discovery-ec2', {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
      }
    }

    // add config to disable security if required
    if (props.securityDisabled && !props.minDistribution) {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; echo "plugins.security.disabled: true" >> config/opensearch.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));

      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;'
          + './bin/opensearch-dashboards-plugin remove securityDashboards --allow-root;'
          + 'sed -i /^opensearch_security/d config/opensearch_dashboards.yml;'
          + 'sed -i \'s/https/http/\' config/opensearch_dashboards.yml',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // Check if there are any jvm properties being passed
    // @ts-ignore
    if (props.jvmSysPropsString.toString() !== 'undefined') {
      // @ts-ignore
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd opensearch; jvmSysPropsList=$(echo "${props.jvmSysPropsString.toString()}" | tr ',' '\\n');`
      + 'for sysProp in $jvmSysPropsList;do echo "-D$sysProp" >> config/jvm.options;done',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // final run command based on whether the distribution type is min or bundle
    if (props.minDistribution) { // using (stackProps.minDistribution) condition is not working when false value is being sent
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; sudo -u ec2-user nohup ./bin/opensearch >> install.log 2>&1 &',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    } else {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch; sudo -u ec2-user nohup ./opensearch-tar-install.sh >> install.log 2>&1 &',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }

    cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd opensearch-dashboards;'
        + 'sudo -u ec2-user nohup ./bin/opensearch-dashboards > dashboard_install.log 2>&1 &', {
      cwd: '/home/ec2-user',
      ignoreErrors: false,
    }));

    return cfnInitConfig;
  }

  private static getCfnInitElementElasticsearch(scope: Stack, logGroup: LogGroup, props: infraProps, nodeType?: string): InitElement[] {
    const configFileDir = join(__dirname, '../opensearch-config');
    let opensearchConfig: string;

    const cfnInitConfig : InitElement[] = [
      InitPackage.yum('amazon-cloudwatch-agent'),
      // For logging plugin
      InitPackage.yum('git'),
      CloudwatchAgent.asInitFile('/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
        {
          agent: {
            metrics_collection_interval: 60,
            logfile: '/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log',
            omit_hostname: true,
            debug: false,
          },
          metrics: {
            metrics_collected: {
              cpu: {
                measurement: [
                  // eslint-disable-next-line max-len
                  'usage_active', 'usage_guest', 'usage_guest_nice', 'usage_idle', 'usage_iowait', 'usage_irq', 'usage_nice', 'usage_softirq', 'usage_steal', 'usage_system', 'usage_user', 'time_active', 'time_iowait', 'time_system', 'time_user',
                ],
              },
              disk: {
                measurement: [
                  'free', 'total', 'used', 'used_percent', 'inodes_free', 'inodes_used', 'inodes_total',
                ],
              },
              diskio: {
                measurement: [
                  'reads', 'writes', 'read_bytes', 'write_bytes', 'read_time', 'write_time', 'io_time',
                ],
              },
              mem: {
                measurement: [
                  'active', 'available', 'available_percent', 'buffered', 'cached', 'free', 'inactive', 'total', 'used', 'used_percent',
                ],
              },
              net: {
                measurement: [
                  'bytes_sent', 'bytes_recv', 'drop_in', 'drop_out', 'err_in', 'err_out', 'packets_sent', 'packets_recv',
                ],
              },
            },
          },
          logs: {
            logs_collected: {
              files: {
                collect_list: [
                  {
                    file_path: `/home/ec2-user/elasticsearch/logs/${scope.stackName}-${scope.account}-${scope.region}.log`,
                    log_group_name: `${logGroup.logGroupName.toString()}`,
                    // eslint-disable-next-line no-template-curly-in-string
                    log_stream_name: '{instance_id}',
                    auto_removal: true,
                  },
                  {
                    file_path: '/httpTraceLogs/http_trace.log',
                    log_group_name: 'opensearchLogGroup/loggingPlugin.log',
                    log_stream_name: '{instance_id}',
                    auto_removal: true,
                  },
                ],
              },
            },
            force_flush_interval: 5,
          },
        }),
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex;/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s'),
      InitCommand.shellCommand('set -ex; sudo echo "vm.max_map_count=262144" >> /etc/sysctl.conf;sudo sysctl -p'),
      // Fetch and unpack Elasticsearch tarball
      InitCommand.shellCommand(`set -ex;mkdir elasticsearch; curl -L ${props.distributionUrl} -o elasticsearch.tar.gz;`
          + 'tar zxf elasticsearch.tar.gz -C elasticsearch --strip-components=1; chown -R ec2-user:ec2-user elasticsearch;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }),
      // Logging plugin setup
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex; cd /home/ec2-user; git clone https://github.com/lewijacn/opensearch-migrations.git; cd opensearch-migrations; git checkout add-gradle-task'),
      // InitCommand.shellCommand('set -ex; chown -R ec2-user:ec2-user /home/ec2-user/opensearch-migrations'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex; export JAVA_HOME=/home/ec2-user/elasticsearch/jdk; cd /home/ec2-user/opensearch-migrations/plugins/elasticsearch/loggable-transport-netty4; ./gradlew assemble'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex; cd /home/ec2-user/opensearch-migrations/cluster_traffic_capture/elasticsearch_with_loggging; cp log4j2.properties /home/ec2-user/elasticsearch/config/'),
      InitCommand.shellCommand('set -ex; sudo mkdir /httpTraceLogs; sudo chown ec2-user /httpTraceLogs'),
      // eslint-disable-next-line max-len
      InitCommand.shellCommand('set -ex; cd /home/ec2-user; ./elasticsearch/bin/elasticsearch-plugin install file:/home/ec2-user/opensearch-migrations/plugins/elasticsearch/loggable-transport-netty4/build/distributions/LoggableNetty4-7.10.2.zip'),
      InitCommand.shellCommand('sleep 15'),
    ];

    if (props.dashboardsUrl) {
      // Remove sleep command until after Kibana unpack command
      cfnInitConfig.pop();
      // Fetch and unpack Kibana tarball
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;mkdir kibana; curl -L ${props.dashboardsUrl} -o kibana.tar.gz;`
          + 'tar zxf kibana.tar.gz -C kibana --strip-components=1; chown -R ec2-user:ec2-user kibana;', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
      cfnInitConfig.push(InitCommand.shellCommand('sleep 15'));
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd kibana;echo "server.host: 0.0.0.0" >> config/kibana.yml',
        {
          cwd: '/home/ec2-user',
          ignoreErrors: false,
        }));
    }

    // Add elasticsearch.yml config
    if (props.singleNodeCluster) {
      const fileContent: any = load(readFileSync(`${configFileDir}/single-node-base-config.yml`, 'utf-8'));

      fileContent['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;

      console.log(dump(fileContent).toString());
      opensearchConfig = dump(fileContent).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd elasticsearch; echo "${opensearchConfig}" > config/elasticsearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));
    } else {
      const baseConfig: any = load(readFileSync(`${configFileDir}/multi-node-base-config.yml`, 'utf-8'));

      baseConfig['cluster.name'] = `${scope.stackName}-${scope.account}-${scope.region}`;
      const commonConfig = dump(baseConfig).toString();
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd elasticsearch; echo "${commonConfig}" > config/elasticsearch.yml`,
        {
          cwd: '/home/ec2-user',
        }));

      if (nodeType != null) {
        const nodeTypeConfig = nodeConfig.get(nodeType);
        const nodeConfigData = dump(nodeTypeConfig).toString();
        cfnInitConfig.push(InitCommand.shellCommand(`set -ex;cd elasticsearch; echo "${nodeConfigData}" >> config/elasticsearch.yml`,
          {
            cwd: '/home/ec2-user',
          }));
      }

      // Install EC2 discovery plugin
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd elasticsearch; echo "y"|sudo -u ec2-user bin/elasticsearch-plugin install discovery-ec2', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // Check if there are any jvm properties being passed
    // @ts-ignore
    if (props.jvmSysPropsString.toString() !== 'undefined') {
      // @ts-ignore
      cfnInitConfig.push(InitCommand.shellCommand(`set -ex; cd elasticsearch; jvmSysPropsList=$(echo "${props.jvmSysPropsString.toString()}" | tr ',' '\\n');`
          + 'for sysProp in $jvmSysPropsList;do echo "-D$sysProp" >> config/jvm.options;done',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    // Final run command for node, there does not seem to be a concept of a min distribution for ES OSS versions so no distinction
    // is seen here for the run command as with OS versions
    cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd elasticsearch; sudo -u ec2-user nohup ./bin/elasticsearch >> install.log 2>&1 &',
      {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));

    // Final run command for kibana dashboards
    if (props.dashboardsUrl) {
      cfnInitConfig.push(InitCommand.shellCommand('set -ex;cd kibana;'
          + 'sudo -u ec2-user nohup ./bin/kibana > dashboard_install.log 2>&1 &', {
        cwd: '/home/ec2-user',
        ignoreErrors: false,
      }));
    }

    return cfnInitConfig;
  }
}
