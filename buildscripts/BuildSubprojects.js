import rimraf from 'rimraf';
import { glob, globStream } from 'glob';
import { spawn } from 'child_process';
import Promise from 'bluebird';
import fs from 'fs';
import minimist from 'minimist';
import copyfiles from 'copyfiles';
import path from 'path';
import vm from 'vm';
import { ProcessFeedback } from './ProcessFeedback.js';
import { ConditionNotMet } from './ConditionNotMet.js';
import { Unchanged } from './Unchanged.js';

import chalk from 'chalk'; // Ensure the 'chalk' package is installed in your project

const fileStream = fs;

const fileStreamPromises = fs.promises;
const projectGroups = JSON.parse(fileStream.readFileSync('BuildSubprojects.json', 'utf8'));
const npmcli = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const yarncli = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const useYarn = true;

//const rebuild = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
const globOptions = {};

const copyfilesAsync = Promise.promisify(copyfiles);
const rimrafAsync = Promise.promisify(rimraf);
const globAsync = Promise.promisify(glob.globStream);





/**
 * Prints an error message as a grid.
 * @param {string} errorMsg - The error message to display.
 */
function printErrorAsGrid(errorMsg) {
  const topBottomBorder = borderChar.repeat(gridWidth + 2);
  const paddedMessage = `${borderChar}${paddingChar.repeat(padding)}${chalk.red(
    errorMsg,
  )}${paddingChar.repeat(padding)}${borderChar}`; // Highlight error message in red

  const borderChar = '*';
  const paddingChar = ' ';
  const padding = 2;
  const messageLength = errorMsg.length;
  const gridWidth = messageLength + padding * 2;

  console.log(topBottomBorder);
  console.log(paddedMessage);
  console.log(topBottomBorder);
}




/**
 * Prints a success message highlighted in green.
 * @param {string} successMsg - The success message to display.
 */
function printSuccess(successMsg) {
  console.log(chalk.green(successMsg)); // Highlight success message in green
}




/**
 * Main entry point for the application. It processes command line arguments, sets up the environment,
 * and orchestrates project group processing.
 *
 * @param {object} args - The command line arguments passed to the application. Must include a build type as the first argument.
 * @return {Promise<number>} A promise that resolves with 0 if the process completes successfully, or 1 if there is a failure.
 */
function main(args) {
  if (args.length === 0) {
    console.error('No command line parameters specified');
    return Promise.reject(1);
  }

  const globalFeedback = new ProcessFeedback('global');
  const buildType = args._[0];
  printSuccess('Build Arguments:')
  console.table(args)
  setupEnvironment(buildType);

  const buildStateFilePath = `./BuildState_${buildType}.json`;
  const buildState = loadBuildState(buildStateFilePath);

  const failed = false;
  printSuccess("Starting to process projects")
  console.table(projectGroups);

  return Promise.each(projectGroups, projects =>
    processProjectGroup(
      projects,
      buildType,
      args,
      buildState,
      buildStateFilePath,
      failed,
    ),
  ).then(() => (failed ? 1 : 0));
}

/**
 * Sets up the appropriate environment variables for the build type.
 * @param {string} buildType - The type of the build ('app', 'out', etc.).
 */
function setupEnvironment(buildType) {
  process.env.TARGET_ENV = buildType === 'app' ? 'production' : 'development';
}

/**
 * Loads the build state from a specified file, falling back to an empty object on error.
 * @param {string} filePath - Path to the build state JSON file.
 * @returns {Object} The parsed build state as an object.
 */
function loadBuildState(filePath) {
  try {
    let fileLines = fileStream.readFileSync(filePath, 'utf8');
    return JSON.parse(fileLines);
  } catch {
    return {};
  }
}

/**
 * Processes a group of projects sequentially.
 * @param {Array} projects - Array of project configurations in the group.
 * @param {string} buildType - The build type ('app', 'out', etc.).
 * @param {Object} args - Command line arguments passed to the program.
 * @param {Object} buildState - The current state of the build process.
 * @param {string} buildStateFilePath - The file path to save the build state.
 * @param {boolean} failed - Indicates whether any project has failed.
 * @returns {Promise} A Promise that resolves when all projects in the group are processed.
 */
function processProjectGroup(
  projects,
  buildType,
  args,
  buildState,
  buildStateFilePath,
  failed,
) {
  return Promise.map(
    projects,
    project => {
      if (!shouldProcessProject(project, buildType)) {
        return Promise.resolve();
      }

      const feedback = new ProcessFeedback(project.name);
      return processSingleProject(
        project,
        buildType,
        args,
        buildState,
        buildStateFilePath,
        feedback,
        failed,
      );
    },
    { concurrency: 1 },
  );
}




/**
 * Determines if a project should be processed based on variant or build type.
 * @param {Object} project - Project definition object.
 * @param {string} buildType - The build type ('app', 'out', etc.).
 * @returns {boolean} True if the project should be processed, otherwise false.
 */
function shouldProcessProject(project, buildType) {
  return (
    project.variant === undefined ||
    buildType === 'out' ||
    process.env.VORTEX_VARIANT === project.variant
  );
}




/**
 * Processes an individual project: checks for changes, processes the project data, and handles errors.
 * @param {Object} project - The project configuration object.
 * @param {string} buildType - The build type ('app', 'out', etc.).
 * @param cmdArgs
 * @param {Object} buildState - The current state of the build.
 * @param {string} buildStateFilePath - The file path to save updated build state.
 * @param {Object} feedback - Feedback object for logging.
 * @param hasFailed
 * @returns {Promise} A Promise that resolves after the project is processed.
 */
function processSingleProject(
  project,
  buildType,
  cmdArgs,
  buildState,
  buildStateFilePath,
  feedback,
  hasFailed,
) {
  // Determine if changes should be forced
  function shouldForceChanges(project, cmdArgs, buildState) {
    return cmdArgs.f || buildState[project.name] === undefined;
  }

  // Helper function to handle unchanged projects
  function rejectUnchanged(latestModificationTime, buildState, projectName) {
    if (latestModificationTime !== undefined && latestModificationTime < buildState[projectName]) {
      return Promise.reject(new Unchanged());
    }
    return Promise.resolve();
  }

  return changes(
    project.path || '.',                    // Base path for changes
    project.sources,                        // File patterns to monitor
    shouldForceChanges(project, cmdArgs, buildState), // Force changes as required
  )
    .then(latestModificationTime =>
      rejectUnchanged(latestModificationTime, buildState, project.name),
    )
    .then(() => processProject(project, buildType, feedback, cmdArgs.noparallel))
    .then(() => saveBuildState(buildState, buildStateFilePath, project.name))
    .catch(err => handleProjectError(err, project, hasFailed));
}




/**
 * Saves the updated build state to a file.
 * @param {Object} buildState - The current build state object.
 * @param {string} filePath - Path where the build state should be saved.
 * @param {string} projectName - The name of the project being updated.
 * @returns {Promise} A Promise that resolves after the state is saved.
 */
function saveBuildState(buildState, filePath, projectName) {
  buildState[projectName] = Date.now();
  return fileStreamPromises.writeFile(filePath, JSON.stringify(buildState, undefined, 2));
}




/**
 * Handles errors encountered while processing a project.
 * @param {Error} err - The error object.
 * @param {Object} project - The project being processed.
 * @param {boolean} failed - Reference indicating if a failure occurred.
 */
function handleProjectError(err, project, failed) {
  if (err instanceof Unchanged) {
    printErrorAsGrid(`No changes detected for ${project.name}`);
    console.log('nothing to do', project.name);
  } else if (err instanceof ConditionNotMet) {
    printErrorAsGrid(`Condition not met for ${project.name}`);
    console.log("condition wasn't met", project.name);
  } else {
    printErrorAsGrid(`Error processing ${project.name}: ${err.message}`);
    console.log(err.stack);
    console.error('failed', project.name, err);
    failed = true;
  }
}





/**
 * Handles the output and events for a given child process.
 *
 * @param {ChildProcessWithoutNullStreams} proc - The spawned process instance.
 * @param {string} desc - A human-readable description of the spawned process.
 * @param {Object} logger - The logger object with methods: `log`, `err`, `finish`.
 * @param {Function} resolve - The resolve callback for the Promise.
 * @param {Function} reject - The reject callback for the Promise.
 */
function handleProcessOutput(proc, desc, logger, resolve, reject) {
  proc.stdout.on('data', data => logger.log(data.toString()));
  proc.stderr.on('data', data => logger.err(data.toString()));
  proc.on('error', err => reject(err));
  proc.on('close', code => {
    logger.finish(desc, code);
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`${desc} failed with code ${code}`));
    }
  });
}

/**
 * Spawns a child process to execute a command asynchronously.
 *
 * @param {string} exe - The executable or command to run.
 * @param {string[]} args - An array of arguments to pass to the command.
 * @param {Object} options - Options to configure the spawning of the process, such as `cwd`, `env`, etc.
 * @param {Object} logger - An object with logging methods: `log`, `err`, and `finish`, used for outputting process information.
 * @return {Promise<void>} Resolves if the process exits with code 0, otherwise rejects with an error.
 */
function spawnAsync(exe, args, options, logger) {
  return new Promise((resolve, reject) => {
    const desc = `${options.cwd || '.'}/${exe} ${args.join(' ')}`;
    printSuccess(`Starting: ${desc}`);

    const proc = spawn(exe, args, { ...options, shell: true });
    handleProcessOutput(proc, desc, logger, resolve, reject);
  });
}




function npm(command, args, options, out) {
  if (!useYarn && command === 'add') {
    command = 'install';
  }
  return spawnAsync(
    useYarn ? yarncli : npmcli,
    [command, ...args, '--mutex', 'file'],
    options,
    out,
  );
}




/**
 * Processes file patterns to determine the most recent modification time of the matched files.
 *
 * @param {string} basePath - The base directory path where the patterns are executed.
 * @param {string[]} patterns - An array of glob patterns to match files.
 * @param {boolean} force - If true, bypasses processing the patterns and resolves immediately.
 * @return {Promise<number|undefined>} - A promise that resolves to the latest modification time in milliseconds, or undefined if bypassed.
 */
function changes(basePath, patterns, force) {
  if (patterns === undefined || force) {
    return Promise.resolve();
  }
  // glob all the patterns, then map all the files to their last modified time,
  // then get the newest of those modified times
  return Promise.reduce(
    patterns,
    (total, pattern) =>
      globAsync(path.join(basePath, pattern), globOptions).then(files =>
        [].concat(total, files),
      ),
    [],
  )
    .map(filePath => fileStreamPromises.stat(filePath).then(stat => stat.mtime.getTime()))
    .then(fileTimes => Math.max(...fileTimes));
}



/**
 * Formats a string by replacing placeholders with corresponding values from the parameters object.
 * Placeholders are defined using curly braces with the parameter key inside (e.g., {key}).
 *
 * @param {string} fmt The format string containing placeholders to replace.
 * @param {Object} parameters An object containing key-value pairs, where keys correspond to the placeholders in the format string.
 * @return {string} The formatted string with placeholders replaced by corresponding values, or left unchanged if no match is found in the parameters object.
 */
function format(fmt, parameters) {
  return fmt.replace(/{([a-zA-Z_]+)}/g, (match, key) => {
    return typeof parameters[key] !== 'undefined' ? parameters[key] : match;
  });
}




/**
 * Processes a project module by installing dependencies, building the project,
 * removing the module directory, and re-adding the module.
 *
 * @param {{type: string, condition: string}} project - The project configuration object.
 * @param {string} project.path - The file system path to the project.
 * @param {string} project.module - The name of the module to be processed.
 * @param {string|boolean} [project.build] - The build script name or a flag indicating if the project should be built.
 * @param {string} buildType - The type of build (e.g., development or production) used for resolving module paths.
 * @param {ProcessFeedback} feedback - A callback function for logging or tracking progress.
 * @return {Promise<void>} A promise that resolves after the module is processed.
 */
function processModule(project, buildType, feedback) {
  const { cwd, modulePath } = getModulePaths(buildType, project.module);
  const npmOptions = { cwd };

  const buildTask = project.build
    ? npm('install', [], { cwd: project.path }, feedback).then(() =>
        npm(
          'run',
          [typeof project.build === 'string' ? project.build : 'build'],
          { cwd: project.path },
          feedback,
        ),
      )
    : Promise.resolve();

  return buildTask
    .then(() => rimrafAsync(modulePath))
    .then(() => npm('add', [project.module], npmOptions, feedback));
}




/**
 * Constructs and returns the paths for the current working directory and the module directory
 * based on the provided build type and module name.
 *
 * @param {string} buildType - The type of build directory (e.g., 'out', 'lib') used to determine the base path.
 * @param {string} moduleName - The name of the module for which the path is being generated.
 * @return {Object} An object containing `cwd` (current working directory path) and `modulePath` (module directory path).
 */
function getModulePaths(buildType, moduleName) {
  const cwd = buildType !== 'out' ? path.join(__dirname, buildType) : __dirname;
  const modulePath = path.join(
    buildType !== 'out' ? buildType : '',
    'node_modules',
    moduleName,
  );
  return { cwd, modulePath };
}



/**
 * Updates the source map reference in a given file by modifying its sourceMappingURL pattern.
 *
 * @param {string} filePath - The path to the file whose source map reference needs to be updated.
 * @return {Promise<void>} Resolves when the file has been successfully updated.
 */
async function updateSourceMap(filePath) {
  let fileContent = await fileStream.promises.readFile(filePath, {
    encoding: 'utf8',
  });

  const moduleDirectoryName = path.basename(path.dirname(filePath));

  const updatedContent = fileContent.replace(
    /\/\/# sourceMappingURL=([a-z\-.]+\.js\.map)$/,
    `//# sourceMappingURL=bundledPlugins/${moduleDirectoryName}/$1`,
  );

  await fileStream.promises.writeFile(filePath, updatedContent);
}

/**
 * Processes a custom project build by running npm commands and handling optional file operations.
 *
 * @param {{type: string, condition: string}} project - The project configuration object.
 * @param {string} project.path - The file path to the project.
 * @param {string|boolean} project.build - The build command or flag to identify the build process.
 * @param {string|undefined} project.copyTo - The destination path for files to be copied after the build.
 * @param {number|undefined} project.depth - The directory depth for file copying operations.
 * @param {string} buildType - The type of the build, used to format the output directory.
 * @param {ProcessFeedback} feedback - A callback function for handling npm command feedback.
 * @param {boolean} noparallel - A flag to indicate whether to limit concurrency during npm installation.
 * @return {Promise<void>} A promise that resolves when the processing is complete, including optional file copying and cleanup operations.
 */
function processCustom(project, buildType, feedback, noparallel) {
  const buildStartTime = Date.now();
  const installationArgs = noparallel ? ['--network-concurrency', '1'] : [];
  let buildProcess = npm(
    'install',
    installationArgs,
    { cwd: project.path },
    feedback,
  ).then(() =>
    npm(
      'run',
      [typeof project.build === 'string' ? project.build : 'build'],
      { cwd: project.path },
      feedback,
    ),
  );

  if (project.copyTo !== undefined) {
    const sourceFilesPattern = path.join(project.path, 'dist', '**', '*');
    const outputPath = format(project.copyTo, { BUILD_DIR: buildType });
    printSuccess('Copying files', sourceFilesPattern, outputPath);

    buildProcess = buildProcess
      .then(() =>
        copyfilesAsync([sourceFilesPattern, outputPath], project.depth || 3),
      )
      .then(() => updateSourceMap(path.join(outputPath, 'index.js')));
  }

  buildProcess = buildProcess.then(() => {
    const buildDurationInSeconds = (Date.now() - buildStartTime) / 1000;
    console.log(
      `Project build at ${project.path} took ${buildDurationInSeconds} seconds`,
    );
  });

  return buildProcess;
}

function evalCondition(condition, context) {
  if (condition === undefined) {
    return true;
  }
  const script = new vm.Script(condition);
  return script.runInNewContext({ ...context, process });
}

/**
 * Process a project based on its type and configuration
 * @param {Object} project - The project configuration object
 * @param {string} project.type - Type of project ('install-module', 'build-copy', etc)
 * @param {string} project.condition - Optional condition to evaluate before processing
 * @param {string} buildType - The build type ('app', 'out', etc)
 * @param {ProcessFeedback} feedback - Feedback object for logging
 * @param {boolean} noparallel - Whether to disable parallel processing
 * @returns {Promise} Promise that resolves when processing is complete
 * @throws {ConditionNotMet} If the project condition evaluates to false
 * @throws {Error} If the project type is invalid
 */
function processProject(project, buildType, feedback, noparallel) {
  if (!evalCondition(project.condition, { buildType })) {
    return Promise.reject(new ConditionNotMet());
  }
  if (project.type === 'install-module') {
    return processModule(project, buildType, feedback);
  } else if (project.type === 'build-copy') {
    return processCustom(project, buildType, feedback, noparallel);
    // } else if (project.type === 'electron-rebuild') {
    //   return processRebuild(project, buildType, feedback);
  }
  if (project.type.startsWith('_')) {
    return Promise.resolve();
  }
  return Promise.reject(
    new Error('invalid project descriptor ' + project.toString()),
  );
}

const args = minimist(process.argv.slice(2));
main(args)
  // just run a second time, to repeat all failed builds
  .then(() => main(args))
  .then(res => process.exit(res));
