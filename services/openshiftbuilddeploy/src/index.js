// @flow

const Promise = require("bluebird");
const OpenShiftClient = require('openshift-client');
const sleep = require("es7-sleep");
const { logger } = require('@amazeeio/lagoon-commons/src/local-logging');
const { getOpenShiftInfoForProject } = require('@amazeeio/lagoon-commons/src/api');

const { sendToAmazeeioLogs, initSendToAmazeeioLogs } = require('@amazeeio/lagoon-commons/src/logs');
const { consumeTasks, initSendToAmazeeioTasks, createTaskMonitor } = require('@amazeeio/lagoon-commons/src/tasks');

initSendToAmazeeioLogs();
initSendToAmazeeioTasks();

const ciUseOpenshiftRegistry = process.env.CI_USE_OPENSHIFT_REGISTRY || "false"
const gitSafeBranch = process.env.AMAZEEIO_GIT_SAFE_BRANCH || "develop"

const messageConsumer = async msg => {
  const {
    projectName,
    branchName,
    sha,
    type,
    headBranchName,
    headSha,
    baseBranchName,
    baseSha
  } = JSON.parse(msg.content.toString())

  logger.verbose(`Received DeployOpenshift task for project: ${projectName}, branch: ${branchName}, sha: ${sha}`);

  const result = await getOpenShiftInfoForProject(projectName);
  const projectOpenShift = result.project

  const ocsafety = string => string.toLocaleLowerCase().replace(/[^0-9a-z-]/g,'-')

  try {
    var safeBranchName = ocsafety(branchName)
    var safeProjectName = ocsafety(projectName)
    var gitSha = sha
    var openshiftConsole = projectOpenShift.openshift.console_url.replace(/\/$/, "");
    var openshiftToken = projectOpenShift.openshift.token || ""
    var openshiftProject = `${safeProjectName}-${safeBranchName}`
    var openshiftProjectUser = projectOpenShift.openshift.project_user || ""
    var deployPrivateKey = projectOpenShift.customer.private_key
    var gitUrl = projectOpenShift.git_url
    var routerPattern = projectOpenShift.openshift.router_pattern ? projectOpenShift.openshift.router_pattern.replace('${branch}',safeBranchName).replace('${project}', safeProjectName) : ""
    var prHeadBranchName = headBranchName || ""
    var prHeadSha = headSha || ""
    var prBaseBranchName = baseBranchName || ""
    var prBaseSha = baseSha || ""
  } catch(error) {
    logger.error(`Error while loading information for project ${projectName}`)
    logger.error(error)
    throw(error)
  }

  // Deciding which git REF we would like deployed, if we have a sha given, we use that, if not we fall back to the branch (which needs be prefixed by `origin/`)
  var gitRef = gitSha ? gitSha : `origin/${branchName}`

  // Generates a buildconfig object
  const buildconfig = (resourceVersion, secret, type) => {

    let buildFromImage = {}
    // During CI we want to use the OpenShift Registry for our build Image and use the OpenShift registry for the base Images
    if (ciUseOpenshiftRegistry == "true") {
      buildFromImage = {
        "kind": "ImageStreamTag",
        "namespace": "lagoon",
        "name": "oc-build-deploy-dind:latest"
      }
    } else {
    // By default we load oc-build-deploy-dind from DockerHub with our current branch as tag
      buildFromImage = {
        "kind": "DockerImage",
        "name": `amazeeiolagoon/oc-build-deploy-dind:${gitSafeBranch}`
      }
    }

    let buildconfig = {
      "apiVersion": "v1",
      "kind": "BuildConfig",
      "metadata": {
          "creationTimestamp": null,
          "name": "lagoon",
          "resourceVersion": resourceVersion
      },
      "spec": {
          "nodeSelector": null,
          "postCommit": {},
          "resources": {},
          "runPolicy": "Serial",
          "source": {
              "git": {
                  "uri": gitUrl
              },
              "type": "Git"
          },
          "strategy": {
              "customStrategy": {
                  "secrets": [
                      {
                          "secretSource": {
                              "name": secret
                          },
                          "mountPath": "/var/run/secrets/lagoon/deployer"
                      },
                      {
                        "secretSource": {
                            "name": "lagoon-sshkey"
                        },
                        "mountPath": "/var/run/secrets/lagoon/ssh"
                    }
                  ],
                  "env": [
                      {
                          "name": "TYPE",
                          "value": type
                      },
                      {
                          "name": "GIT_REF",
                          "value": gitRef
                      },
                      {
                          "name": "SAFE_BRANCH",
                          "value": safeBranchName
                      },
                      {
                          "name": "BRANCH",
                          "value": branchName
                      },
                      {
                          "name": "SAFE_PROJECT",
                          "value": safeProjectName
                      },
                      {
                          "name": "PROJECT",
                          "value": projectName
                      },
                      {
                          "name": "ROUTER_URL",
                          "value": routerPattern
                      }
                  ],
                  "forcePull": true,
                  "from": buildFromImage,
              },
              "type": "Custom"
          }
      }
    }
    if (ciUseOpenshiftRegistry == "true") {
      buildconfig.spec.strategy.customStrategy.env.push({"name": "CI_USE_OPENSHIFT_REGISTRY","value": ciUseOpenshiftRegistry})
    }
    if (type == "pullrequest") {
      buildconfig.spec.strategy.customStrategy.env.push({"name": "PR_HEAD_BRANCH","value": prHeadBranchName})
      buildconfig.spec.strategy.customStrategy.env.push({"name": "PR_HEAD_SHA","value": prHeadSha})
      buildconfig.spec.strategy.customStrategy.env.push({"name": "PR_BASE_BRANCH","value": prBaseBranchName})
      buildconfig.spec.strategy.customStrategy.env.push({"name": "PR_BASE_SHA","value": prBaseSha})
    }
    return buildconfig
  }

  // OpenShift API object
  const openshift = new OpenShiftClient.OApi({
    url: openshiftConsole,
    insecureSkipTlsVerify: true,
    auth: {
      bearer: openshiftToken
    },
  });

  // Kubernetes API Object - needed as some API calls are done to the Kubernetes API part of OpenShift and
  // the OpenShift API does not support them.
  const kubernetes = new OpenShiftClient.Core({
    url: openshiftConsole,
    insecureSkipTlsVerify: true,
    auth: {
      bearer: openshiftToken
    },
  });


  // openshift-client does not know about the OpenShift Resources, let's teach it.
  openshift.ns.addResource('buildconfigs');
  openshift.ns.addResource('rolebindings');
  openshift.addResource('projectrequests');

  // Create a new Project if it does not exist
  let projectStatus = {}
  try {
    const projectsGet = Promise.promisify(openshift.projects(openshiftProject).get, { context: openshift.projects(openshiftProject) })
    projectStatus = await projectsGet()
    logger.info(`${openshiftProject}: Project ${openshiftProject} already exists, continuing`)
  } catch (err) {
    // a non existing project also throws an error, we check if it's a 404, means it does not exist, so we create it.
    if (err.code == 404 || err.code == 403) {
      logger.info(`${openshiftProject}: Project ${openshiftProject}  does not exist, creating`)
      const projectrequestsPost = Promise.promisify(openshift.projectrequests.post, { context: openshift.projectrequests })
      await projectrequestsPost({ body: {"apiVersion":"v1","kind":"ProjectRequest","metadata":{"name":openshiftProject},"displayName":`[${projectName}] ${branchName}`} });
    } else {
      logger.error(err)
      throw new Error
    }
  }

  // Used to create RoleBindings
  const rolebindingsPost = Promise.promisify(openshift.ns(openshiftProject).rolebindings.post, { context: openshift.ns(openshiftProject).rolebindings })


  // If a project user is given, give it access to our project.
  if (openshiftProjectUser) {
    try {
      const rolebindingsGet = Promise.promisify(openshift.ns(openshiftProject).rolebindings(`${openshiftProjectUser}-edit`).get, { context: openshift.ns(openshiftProject).rolebindings(`${openshiftProjectUser}-edit`) })
      projectUserRoleBinding = await rolebindingsGet()
      logger.info(`${openshiftProject}: RoleBinding ${openshiftProjectUser}-edit already exists, continuing`)
    } catch (err) {
      if (err.code == 404) {
        logger.info(`${openshiftProject}: RoleBinding ${openshiftProjectUser}-edit does not exists, creating`)
        await rolebindingsPost({ body: {"kind":"RoleBinding","apiVersion":"v1","metadata":{"name":`${openshiftProjectUser}-edit`,"namespace":openshiftProject},"roleRef":{"name":"edit"},"subjects":[{"name":openshiftProjectUser,"kind":"User","namespace":openshiftProject}]}})
      } else {
        logger.error(err)
        throw new Error
      }
    }
  }

  // Create ServiceAccount if it does not exist yet.
  try {
    const serviceaccountsGet = Promise.promisify(kubernetes.ns(openshiftProject).serviceaccounts('lagoon-deployer').get, { context: kubernetes.ns(openshiftProject).serviceaccounts('lagoon-deployer') })
    projectStatus = await serviceaccountsGet()
    logger.info(`${openshiftProject}: ServiceAccount lagoon-deployer already exists, continuing`)
  } catch (err) {
    if (err.code == 404) {
      logger.info(`${openshiftProject}: ServiceAccount lagoon-deployer does not exists, creating`)
      const serviceaccountsPost = Promise.promisify(kubernetes.ns(openshiftProject).serviceaccounts.post, { context: kubernetes.ns(openshiftProject).serviceaccounts })
      await serviceaccountsPost({ body: {"kind":"ServiceAccount","apiVersion":"v1","metadata":{"name":"lagoon-deployer"} }})
      await sleep(2000); // sleep a bit after creating the ServiceAccount for OpenShift to create all the secrets
      await rolebindingsPost({ body: {"kind":"RoleBinding","apiVersion":"v1","metadata":{"name":"laggon-deployer-edit","namespace":openshiftProject},"roleRef":{"name":"edit"},"subjects":[{"name":"lagoon-deployer","kind":"ServiceAccount","namespace":openshiftProject}]}})
    } else {
      logger.error(err)
      throw new Error
    }
  }

  // Create SSH Key Secret if not exist yet, if it does update it.
  let sshKey = {}
  const sshKeyBase64 = new Buffer(deployPrivateKey.replace(/\\n/g, "\n")).toString('base64')
  try {
    const secretsGet = Promise.promisify(kubernetes.ns(openshiftProject).secrets('lagoon-sshkey').get, { context: kubernetes.ns(openshiftProject).secrets('lagoon-sshkey') })
    sshKey = await secretsGet()
    logger.info(`${openshiftProject}: Secret lagoon-sshkey already exists, updating`)
    const secretsPut = Promise.promisify(kubernetes.ns(openshiftProject).secrets('lagoon-sshkey').put, { context: kubernetes.ns(openshiftProject).secrets('lagoon-sshkey') })
    await secretsPut({ body: {"apiVersion":"v1","kind":"Secret","metadata":{"name":"lagoon-sshkey", "resourceVersion": sshKey.metadata.resourceVersion },"type":"kubernetes.io/ssh-auth","data":{"ssh-privatekey":sshKeyBase64}}})
  } catch (err) {
    if (err.code == 404) {
      logger.info(`${openshiftProject}: Secret lagoon-sshkey does not exists, creating`)
      const secretsPost = Promise.promisify(kubernetes.ns(openshiftProject).secrets.post, { context: kubernetes.ns(openshiftProject).secrets })
      await secretsPost({ body: {"apiVersion":"v1","kind":"Secret","metadata":{"name":"lagoon-sshkey"},"type":"kubernetes.io/ssh-auth","data":{"ssh-privatekey":sshKeyBase64}}})
    } else {
      logger.error(err)
      throw new Error
    }
  }

  // Load the Token Secret Name for our created ServiceAccount
  const serviceaccountsGet = Promise.promisify(kubernetes.ns(openshiftProject).serviceaccounts("lagoon-deployer").get, { context: kubernetes.ns(openshiftProject).serviceaccounts("lagoon-deployer") })
  serviceaccount = await serviceaccountsGet()
  // a ServiceAccount can have multiple secrets, we are interested in one that has starts with 'lagoon-deployer-token'
  let serviceaccountTokenSecret = '';
  for (var key in serviceaccount.secrets) {
    if(/^lagoon-deployer-token/.test(serviceaccount.secrets[key].name)) {
      serviceaccountTokenSecret = serviceaccount.secrets[key].name
      break;
    }
  }
  if (serviceaccountTokenSecret == '') {
    throw new Error(`${openshiftProject}: Could not find token secret for ServiceAccount lagoon-deployer`)
  }

  // Create or update the BuildConfig
  try {
    const buildConfigsGet = Promise.promisify(openshift.ns(openshiftProject).buildconfigs('lagoon').get, { context: openshift.ns(openshiftProject).buildconfigs('lagoon') })
    currentBuildConfig = await buildConfigsGet()
    logger.info(`${openshiftProject}: Buildconfig lagoon already exists, updating`)
    const buildConfigsPut = Promise.promisify(openshift.ns(openshiftProject).buildconfigs('lagoon').put, { context: openshift.ns(openshiftProject).buildconfigs('lagoon') })
    // The OpenShift API needs the current resource Version so it knows that we're updating data of the last known version. This is filled within currentBuildConfig.metadata.resourceVersion
    await buildConfigsPut({ body: buildconfig(currentBuildConfig.metadata.resourceVersion, serviceaccountTokenSecret, type) })
  } catch (err) {
    // Same as for projects, if BuildConfig does not exist, it throws an error and we check the error is an 404 and with that we know it does not exist.
    if (err.code == 404) {
      logger.info(`${openshiftProject}: Buildconfig lagoon does not exist, creating`)
      const buildConfigsPost = Promise.promisify(openshift.ns(openshiftProject).buildconfigs.post, { context: openshift.ns(openshiftProject).buildconfigs })
      // This is a complete new BuildConfig, so the resource version is "0" (it will be updated automatically by OpenShift)
      await buildConfigsPost({ body: buildconfig("0", serviceaccountTokenSecret, type) })
    } else {
      logger.error(err)
      throw new Error
    }
  }

  // Instantiate = Create a new Build from an existing BuildConfig
  const buildConfigsInstantiatePost = Promise.promisify(openshift.ns(openshiftProject).buildconfigs('lagoon/instantiate').post, { context: openshift.ns(openshiftProject).buildconfigs('lagoon/instantiate') })
  const build = await buildConfigsInstantiatePost({body: {"kind":"BuildRequest","apiVersion":"v1","metadata":{"name":"lagoon"}}})
  const buildName = build.metadata.name

  logger.verbose(`${openshiftProject}: Running build: ${buildName}`)

  const monitorPayload = {
    buildName: buildName,
    projectName: projectName,
    openshiftProject: openshiftProject,
    branchName: branchName,
    sha: sha
  }

  const taskMonitorLogs = await createTaskMonitor('builddeploy-openshift', monitorPayload)

  let logMessage = ''
  if (gitSha) {
    logMessage = `\`${branchName}\` (${buildName})`
  } else {
    logMessage = `\`${branchName}\``
  }

  sendToAmazeeioLogs('start', projectName, "", "task:builddeploy-openshift:start", {},
    `*[${projectName}]* ${logMessage}`
  )

}

const deathHandler = async (msg, lastError) => {
  const {
    projectName,
    branchName,
    sha
  } = JSON.parse(msg.content.toString())

  let logMessage = ''
  if (sha) {
    logMessage = `\`${branchName}\` (${sha.substring(0, 7)})`
  } else {
    logMessage = `\`${branchName}\``
  }

  sendToAmazeeioLogs('error', projectName, "", "task:builddeploy-openshift:error",  {},
`*[${projectName}]* ${logMessage} ERROR:
\`\`\`
${lastError}
\`\`\``
  )

}

const retryHandler = async (msg, error, retryCount, retryExpirationSecs) => {
  const {
    projectName,
    branchName,
    sha
  } = JSON.parse(msg.content.toString())

  let logMessage = ''
  if (sha) {
    logMessage = `\`${branchName}\` (${sha.substring(0, 7)})`
  } else {
    logMessage = `\`${branchName}\``
  }

  sendToAmazeeioLogs('warn', projectName, "", "task:builddeploy-openshift:retry", {error: error.message, msg: JSON.parse(msg.content.toString()), retryCount: retryCount},
`*[${projectName}]* ${logMessage} ERROR:
\`\`\`
${error}
\`\`\`
Retrying deployment in ${retryExpirationSecs} secs`
  )
}
consumeTasks('builddeploy-openshift', messageConsumer, retryHandler, deathHandler)
