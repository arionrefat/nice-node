import type Node from '../common/node';
import {
  type NodeId,
  type NodeRuntime,
  NodeStatus,
  NodeStoppedBy,
  createNode,
  isDockerNode,
} from '../common/node';
import { injectDefaultControllerConfig } from '../common/node-spec-tool/injectDefaultControllerConfig.js';
import { calcNewControllerConfig } from '../common/node-spec-tool/updateActiveControllerConfig.js';
import type {
  ConfigTranslationMap,
  ConfigValuesMap,
} from '../common/nodeConfig';

import type { NodeSpecification } from '../common/nodeSpec';
import { NOTIFICATIONS } from './consts/notifications.js';
import { deleteDisk, getNodesDirPath, makeNodeDir } from './files';
import logger from './logger';
import { setLastRunningTime } from './node/setLastRunningTime';
import { initialize as initNodeLibrary } from './nodeLibraryManager';
import { getCheckForControllerUpdate } from './nodeLibraryManager.js';
import {
  createRunCommand,
  sendLogsToUI as dockerSendLogsToUI,
  stopSendingLogsToUI as dockerStopSendingLogsToUI,
  getContainerDetails,
  initialize as initDocker,
  onExit as onExitDocker,
  removePodmanNode,
  startPodmanNode,
  stopPodmanNode,
} from './podman/podman';
import { checkNodePortsAndNotify } from './ports';
import { getNodeLibrary } from './state/nodeLibrary';
import * as nodeStore from './state/nodes';
import { getSetPortHasChanged } from './state/nodes';
import { getNode } from './state/nodes.js';
import { addNotification } from './state/notifications.js';

export const addNode = async (
  nodeSpec: NodeSpecification,
  storageLocation?: string,
  initialConfigFromUser?: ConfigValuesMap,
): Promise<Node> => {
  // use a timestamp postfix so the user can add multiple nodes of the same name
  const utcTimestamp = Math.floor(Date.now() / 1000);
  const dataDir = await makeNodeDir(
    `${nodeSpec.specId}-${utcTimestamp}`,
    storageLocation ?? getNodesDirPath(),
  );
  // We really do not want to have conditionals for specific nodes, however,
  //  this is justified as we iterate quickly for funding and prove NN works
  if (nodeSpec.specId === 'hubble') {
    await makeNodeDir('hub', dataDir);
    await makeNodeDir('rocks', dataDir);
  }
  console.log('adding node with dataDir: ', dataDir);
  console.log(
    'adding node with initialConfigFromUser: ',
    initialConfigFromUser,
  );
  const nodeRuntime: NodeRuntime = {
    dataDir,
    usage: {
      diskGBs: [],
      memoryBytes: [],
      cpuPercent: [],
      syncedBlock: 0,
    },
  };
  const node: Node = createNode({
    spec: nodeSpec,
    runtime: nodeRuntime,
    initialConfigFromUser,
  });
  nodeStore.addNode(node);

  setTimeout(() => {
    const runningNode = nodeStore.getNodeBySpecId(node.spec.specId);
    if (runningNode?.status === NodeStatus.running) {
      checkNodePortsAndNotify(runningNode);
    }
  }, 600000); // 10 minutes
  return node;
};

// Useful for users "ejecting" from using the UI
export const getNodeStartCommand = (nodeId: NodeId): string => {
  const node = nodeStore.getNode(nodeId);
  if (!node) {
    throw new Error(
      `Unable to get node start command ${nodeId}. Node not found.`,
    );
  }

  try {
    if (isDockerNode(node)) {
      const dockerNode = node;
      console.log('creating node start command');
      // startPodmanNode(dockerNode);
      const startCommand = `podman ${createRunCommand(dockerNode)}`;
      console.log('created node start command', startCommand);

      return startCommand;
    }
  } catch (err) {
    logger.error(err);
  }
  return '';
};

export const startNode = async (nodeId: NodeId) => {
  const node = nodeStore.getNode(nodeId);
  if (!node) throw new Error(`Unable to start node ${nodeId}. Node not found.`);

  logger.info(`Starting node ${JSON.stringify(node)}`);
  node.status = NodeStatus.starting;
  node.lastStartedTimestampMs = Date.now();
  node.stoppedBy = undefined;
  nodeStore.updateNode(node);

  try {
    if (isDockerNode(node)) {
      const containerIds = await startPodmanNode(node);
      node.runtime.processIds = containerIds;
      node.status = NodeStatus.running;
      setLastRunningTime(nodeId, 'nodeService');
      if (getSetPortHasChanged(node)) checkNodePortsAndNotify(node);
    }
  } catch (err) {
    logger.error(err);
    node.status = NodeStatus.errorStarting;
  } finally {
    nodeStore.updateNode(node);
  }
};

export const stopNode = async (nodeId: NodeId, stoppedBy: NodeStoppedBy) => {
  const node = nodeStore.getNode(nodeId);
  if (!node) throw new Error(`Unable to stop node ${nodeId}. Node not found.`);

  logger.info(`Stopping node ${JSON.stringify(node)}`);
  node.status = NodeStatus.stopping;
  node.lastStoppedTimestampMs = Date.now();
  node.stoppedBy = stoppedBy;
  nodeStore.updateNode(node);

  try {
    if (isDockerNode(node)) {
      await stopPodmanNode(node);
      node.status = NodeStatus.stopped;
    }
  } catch (err) {
    logger.error(err);
  } finally {
    node.status = NodeStatus.stopped;
    nodeStore.updateNode(node);
  }
};

export const resetNodeConfig = (nodeId: NodeId) => {
  const existingNode = nodeStore.getNode(nodeId);

  existingNode.config.configValuesMap = existingNode.spec.execution.input
    ?.defaultConfig as ConfigValuesMap;

  nodeStore.updateNode(existingNode);
};

export const deleteNodeStorage = async (nodeId: NodeId) => {
  const node = nodeStore.getNode(nodeId);
  const nodeDataDirPath = node.runtime.dataDir;
  const deleteDiskResult = await deleteDisk(nodeDataDirPath);
  logger.info(`Remove node deleteDiskResult ${deleteDiskResult}`);
  return deleteDiskResult;
};

export const removeNode = async (
  nodeId: NodeId,
  options: { isDeleteStorage: boolean },
): Promise<Node> => {
  // todo: check if node can be removed. Is it stopped?
  // todo: stop & remove container
  logger.info(
    `Remove node ${nodeId} and delete storage? ${options.isDeleteStorage}`,
  );
  try {
    // Only users remove nodes
    await stopNode(nodeId, NodeStoppedBy.user);
  } catch (err) {
    logger.info(
      'Unable to stop the node before removing. Continuing with removal.',
    );
  }
  const node = nodeStore.getNode(nodeId);
  node.status = NodeStatus.removing;
  nodeStore.updateNode(node);

  // if docker, remove container
  if (isDockerNode(node)) {
    try {
      const isDockerRemoved = await removePodmanNode(node);
      logger.info(`isDockerRemoved ${isDockerRemoved}`);
    } catch (err) {
      logger.error(err);
      // todo: try to remove container with same name?
    }
  }

  if (options?.isDeleteStorage) {
    await deleteNodeStorage(nodeId);
  }

  // todo: delete data optional
  const removedNode = nodeStore.removeNode(nodeId);
  return removedNode;
};

export const stopSendingNodeLogs = (nodeId?: NodeId) => {
  if (nodeId === undefined) {
    dockerStopSendingLogsToUI();
    return;
  }
  const node = nodeStore.getNode(nodeId);
  if (isDockerNode(node)) {
    dockerStopSendingLogsToUI();
  }
};

/**
 * Removes all nodes and deletes their storage data
 */
export const removeAllNodes = async () => {
  const nodes = nodeStore.getNodes();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    await removeNode(node.id, { isDeleteStorage: true });
  }
};

export const sendNodeLogs = (nodeId: NodeId) => {
  const node = nodeStore.getNode(nodeId);
  if (isDockerNode(node)) {
    dockerSendLogsToUI(node);
  }
};

const compareSpecsAndUpdate = (
  node: Node,
  nodeLibraryConfigTranslation: ConfigTranslationMap | undefined,
) => {
  if (node.spec.configTranslation && nodeLibraryConfigTranslation) {
    const nodeSpecKeys = Object.keys(node.spec.configTranslation);
    const nodeLibraryKeys = Object.keys(nodeLibraryConfigTranslation);

    // Compare the two sets of keys
    const areKeysDifferent =
      nodeSpecKeys.length !== nodeLibraryKeys.length ||
      nodeSpecKeys.some((key) => !nodeLibraryKeys.includes(key)) ||
      nodeLibraryKeys.some((key) => !nodeSpecKeys.includes(key));

    // If the keys are different, overwrite node.spec.configTranslation
    if (areKeysDifferent) {
      node.spec.configTranslation = nodeLibraryConfigTranslation;
    }
  }
};

/**
 * Node status must be stopped
 * Calls calcNewControllerConfig to get the new config, then updates the node.spec to newSpec.
 * Todo: restart the node if it was running before the update
 * @param nodeId
 * @param newSpec
 */
export const applyNodeUpdate = async (nodeId: NodeId): Promise<boolean> => {
  // todo: could put this check after stopping?
  const newSpec = await getCheckForControllerUpdate(nodeId);
  let node = getNode(nodeId);
  if (newSpec === undefined) {
    logger.error('Unable to update node. No newer controller found.');
    addNotification(
      NOTIFICATIONS.WARNING.CLIENT_UPDATE_ERROR,
      node.spec.displayName,
    );
    return false;
  }
  const isRunningBeforeUpdate = node.status === NodeStatus.running;
  if (node.status !== NodeStatus.stopped) {
    await stopNode(nodeId, NodeStoppedBy.nodeUpdate);
    node = getNode(nodeId);
  }
  if (
    node.status !== NodeStatus.stopped &&
    node.status !== NodeStatus.errorStopping
  ) {
    addNotification(
      NOTIFICATIONS.WARNING.CLIENT_UPDATE_ERROR,
      node.spec.displayName,
    );
    throw new Error(
      'Unable to stop node before updating. Node is not stopped or is not error stopping.',
    );
  }

  node = getNode(nodeId);
  node.status = NodeStatus.updating;
  nodeStore.updateNode(node);

  // This should always be run before calcNewControllerConfig
  injectDefaultControllerConfig(newSpec);

  // Get the new config - removes unsupported config values, etc.
  const newConfigValuesMap = calcNewControllerConfig(
    newSpec,
    node.config.configValuesMap,
  );
  node.config.configValuesMap = newConfigValuesMap;
  node.spec = newSpec;
  node.updateAvailable = false;
  if (!isRunningBeforeUpdate) {
    node.status = NodeStatus.stopped;
  }
  nodeStore.updateNode(node);

  // Successful update notification
  addNotification(
    NOTIFICATIONS.COMPLETED.CLIENT_UPDATED,
    node.spec.displayName,
  );

  if (isRunningBeforeUpdate) {
    // todo: wait to see if successful before creating notification?
    startNode(nodeId);
  }

  return true;
};

/**
 * Called on app launch.
 * Check's node processes and updates internal NiceNode records.
 */
export const initialize = async () => {
  initDocker();
  initNodeLibrary();
  const nodeLibrary = getNodeLibrary();

  // get all nodes
  const nodes = nodeStore.getNodes();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (isDockerNode(node)) {
      const dockerNode = node;
      if (Array.isArray(dockerNode?.runtime?.processIds)) {
        try {
          const containerDetails = await getContainerDetails(
            dockerNode.runtime.processIds,
          );
          // console.log(
          //   'NodeManager.initialize containerDetails: ',
          //   containerDetails,
          // );
          // {..."State": {
          //     "Status": "exited",
          //     "Running": false,
          //     "Paused": false,
          //     "Restarting": false,
          //     "OOMKilled": false,
          //     "Dead": false,
          //     "Pid": 0,
          //     "ExitCode": 0,
          //     "Error": "",
          //     "StartedAt": "2022-05-03T00:03:29.261322736Z",
          //     "FinishedAt": "2022-05-03T00:04:03.188681812Z"
          // },
          if (containerDetails?.State?.Running) {
            node.status = NodeStatus.running;
            // console.log('checkNode: running', node);
          } else {
            node.status = NodeStatus.stopped;
            // console.log('checkNode: stoppeds', node);
          }
          compareSpecsAndUpdate(
            node,
            nodeLibrary[node.spec.specId].configTranslation,
          );
          nodeStore.updateNode(node);
        } catch (err) {
          // Podman is likely stopped
          // console.error(`Podman found no container for nodeId ${node.id}`);
          node.status = NodeStatus.stopped;
          nodeStore.updateNode(node);
        }
      } else {
        throw new Error(`No containerIds found for nodeId ${node.id}`);
      }
    }
  }
};

export const onExit = () => {
  onExitDocker();
};

// logger.info(
//   `process.env.NN_AUTOSTART_NODE: ${process.env.NN_AUTOSTART_NODE}`
// );
// if (getIsStartOnLogin() || process.env.NN_AUTOSTART_NODE === 'true') {
//   startGeth();
// }
