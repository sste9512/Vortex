const Promise = require("bluebird");
const { spawn } = require("child_process");
const copyfiles = require("copyfiles");
const fs = require("fs");
const fsP = require("fs").promises;
const glob = require("glob");
const minimist = require("minimist");
const path = require("path");
const rimraf = require("rimraf");
const vm = require("vm");

const projectGroups = JSON.parse(fs.readFileSync("./BuildSubprojects.json"));

const packageJSON = JSON.parse(fs.readFileSync("./package.json"));

const npmcli = process.platform === "win32" ? "npm.cmd" : "npm";

const yarncli = process.platform === "win32" ? "yarn.cmd" : "yarn";

const useYarn = true;

//const rebuild = path.join('node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild');
const globOptions = {};

const copyfilesAsync = Promise.promisify(copyfiles);
const rimrafAsync = Promise.promisify(rimraf);
const globAsync = Promise.promisify(glob);

class Unchanged extends Error {
  constructor() {
    super("No changes");
  }
}

class ConditionNotMet extends Error {
  constructor() {
    super("Condition not met");
  }
}
class ProcessFeedback {
  constructor(id) {
    this.id = id;
    this.output = [];
  }

  finish(desc, code) {
    if (code !== 0) {
      this.output.forEach((line) => console.log(line));
    }
    console.log(`(${this.id}) ${desc} finished with code ${code}`);
  }

  log(data) {
    if (data === undefined) {
      return;
    }
    const lines = data.split(/[\r\n\t]+/);
    lines.forEach((line) => {
      if (line.length > 0) {
        this.output.push(`-- ${line}`);
      }
    });
  }

  err(data) {
    if (data === undefined) {
      return;
    }
    const lines = data.split(/[\r\n\t]+/);
    lines.forEach((line) => {
      if (line.length > 0) {
        this.output.push(`xx ${line}`);
      }
    });
  }
}


/**
 * Prints an error message as a grid.
 * @param {string} errorMsg - The error message to display.
 */
function printErrorAsGrid(errorMsg) {
  const borderChar = '*';
  const paddingChar = ' ';
  const padding = 2;
  const messageLength = errorMsg.length;
  const gridWidth = messageLength + padding * 2;

  const topBottomBorder = borderChar.repeat(gridWidth + 2);
  const paddedMessage = `${borderChar}${paddingChar.repeat(padding)}${errorMsg}${paddingChar.repeat(padding)}${borderChar}`;

  console.log(topBottomBorder);
  console.log(paddedMessage);
  console.log(topBottomBorder);
}




function main(args) {
  if (args.length === 0) {
    console.error("No command line parameters specified");
    return Promise.reject(1);
  }

  const globalFeedback = new ProcessFeedback("global");
  const buildType = args._[0];
  setupEnvironment(buildType);

  const buildStateFilePath = `./BuildState_${buildType}.json`;
  const buildState = loadBuildState(buildStateFilePath);

  const failed = false;

  return Promise.each(projectGroups, (projects) =>
    processProjectGroup(projects, buildType, args, buildState, buildStateFilePath, failed)
  ).then(() => (failed ? 1 : 0));
}

/**
 * Sets up the appropriate environment variables for the build type.
 * @param {string} buildType - The type of the build ('app', 'out', etc.).
 */
function setupEnvironment(buildType) {
  process.env.TARGET_ENV = buildType === "app" ? "production" : "development";
}

/**
 * Loads the build state from a specified file, falling back to an empty object on error.
 * @param {string} filePath - Path to the build state JSON file.
 * @returns {Object} The parsed build state as an object.
 */
function loadBuildState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath));
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
function processProjectGroup(projects, buildType, args, buildState, buildStateFilePath, failed) {
  return Promise.map(
    projects,
    (project) => {
      if (!shouldProcessProject(project, buildType)) {
        return Promise.resolve();
      }

      const feedback = new ProcessFeedback(project.name);
      return processSingleProject(project, buildType, args, buildState, buildStateFilePath, feedback, failed);
    },
    { concurrency: 1 }
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
    buildType === "out" ||
    process.env.VORTEX_VARIANT === project.variant
  );
}

/**
 * Processes an individual project: checks for changes, processes the project data, and handles errors.
 * @param {Object} project - The project configuration object.
 * @param {string} buildType - The build type ('app', 'out', etc.).
 * @param {Object} args - Command line arguments provided to the program.
 * @param {Object} buildState - The current state of the build.
 * @param {string} buildStateFilePath - The file path to save updated build state.
 * @param {Object} feedback - Feedback object for logging.
 * @param {boolean} failed - Indicates if any project has failed.
 * @returns {Promise} A Promise that resolves after the project is processed.
 */
function processSingleProject(project, buildType, args, buildState, buildStateFilePath, feedback, failed) {
  return changes(project.path || ".", project.sources, args.f || buildState[project.name] === undefined)
    .then((lastChange) => {
      if (lastChange !== undefined && lastChange < buildState[project.name]) {
        return Promise.reject(new Unchanged());
      }
      return processProject(project, buildType, feedback, args.noparallel);
    })
    .then(() => saveBuildState(buildState, buildStateFilePath, project.name))
    .catch((err) => handleProjectError(err, project, failed));
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
  return fsP.writeFile(filePath, JSON.stringify(buildState, undefined, 2));
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
    console.log("nothing to do", project.name);
  } else if (err instanceof ConditionNotMet) {
    printErrorAsGrid(`Condition not met for ${project.name}`);
    console.log("condition wasn't met", project.name);
  } else {
    printErrorAsGrid( `Error processing ${project.name}: ${err.message}` );
    console.log( err.stack)
    console.error("failed", project.name, err);
    failed = true;
  }
}
function spawnAsync(exe, args, options, out) {
  return new Promise((resolve, reject) => {
    const desc = `${options.cwd || "."}/${exe} ${args.join(" ")}`;
    out.log("started: " + desc);
    try {
      const proc = spawn(exe, args, { ...options, shell: true });
      proc.stdout.on("data", (data) => out.log(data.toString()));
      proc.stderr.on("data", (data) => out.err(data.toString()));
      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        out.finish(desc, code);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${args} failed with code ${code}`));
        }
      });
    } catch (err) {
      out.err(`failed to spawn ${desc}: ${err.message}`);
      reject(err);
    }
  });
}

let nextId = 0;
function getId() {
  return nextId++;
}

function npm(command, args, options, out) {
  if (!useYarn && command === "add") {
    command = "install";
  }
  return spawnAsync(
    useYarn ? yarncli : npmcli,
    [command, ...args, "--mutex", "file"],
    options,
    out
  );
}

function changes(basePath, patterns, force) {
  if (patterns === undefined || force) {
    return Promise.resolve();
  }
  // glob all the patterns, then map all the files to their last modified time,
  // then get the newest of those modified times
  return Promise.reduce(
    patterns,
    (total, pattern) =>
      globAsync(path.join(basePath, pattern), globOptions).then((files) =>
        [].concat(total, files)
      ),
    []
  )
    .map((filePath) => fsP.stat(filePath).then((stat) => stat.mtime.getTime()))
    .then((fileTimes) => Math.max(...fileTimes));
}

function format(fmt, parameters) {
  return fmt.replace(/{([a-zA-Z_]+)}/g, (match, key) => {
    return typeof parameters[key] !== "undefined" ? parameters[key] : match;
  });
}

function processModule(project, buildType, feedback) {
  const options = {};
  let modulePath;
  if (buildType !== "out") {
    options.cwd = path.join(__dirname, buildType);
    modulePath = path.join(buildType, "node_modules", project.module);
  } else {
    options.cwd = __dirname;
    modulePath = path.join("node_modules", project.module);
  }

  const build =
    project.build !== undefined && project.build !== false
      ? npm("install", [], { cwd: project.path }, feedback).then(() =>
        npm(
          "run",
          [typeof project.build === "string" ? project.build : "build"],
          { cwd: project.path },
          feedback
        )
      )
      : Promise.resolve();

  return build
    .then(() => rimrafAsync(modulePath))
    .then(() => npm("add", [project.module], options, feedback));
}

async function updateSourceMap(filePath) {
  let dat = await fs.promises.readFile(filePath, { encoding: "utf8" });

  const modPath = path.basename(path.dirname(filePath));

  dat = dat.replace(
    /\/\/# sourceMappingURL=([a-z\-.]+\.js\.map)$/,
    `//# sourceMappingURL=bundledPlugins/${modPath}/$1`
  );

  await fs.promises.writeFile(filePath, dat);
}

function processCustom(project, buildType, feedback, noparallel) {
  const start = Date.now();
  const instArgs = noparallel ? ["--network-concurrency", "1"] : [];
  let res = npm("install", instArgs, { cwd: project.path }, feedback).then(() =>
    npm(
      "run",
      [typeof project.build === "string" ? project.build : "build"],
      { cwd: project.path },
      feedback
    )
  );
  if (project.copyTo !== undefined) {
    const source = path.join(project.path, "dist", "**", "*");
    const output = format(project.copyTo, { BUILD_DIR: buildType });
    feedback.log("copying files", source, output);
    res = res
      .then(() => copyfilesAsync([source, output], project.depth || 3))
      .then(() => updateSourceMap(path.join(output, "index.js")));
  }
  res = res.then(() => {
    console.log(project.path, "took", (Date.now() - start) / 1000, "s");
  });
  return res;
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
  if (project.type === "install-module") {
    return processModule(project, buildType, feedback);
  } else if (project.type === "build-copy") {
    return processCustom(project, buildType, feedback, noparallel);
    // } else if (project.type === 'electron-rebuild') {
    //   return processRebuild(project, buildType, feedback);
  }
  if (project.type.startsWith("_")) {
    return Promise.resolve();
  }
  return Promise.reject(
    new Error("invalid project descriptor " + project.toString())
  );
}

const args = minimist(process.argv.slice(2));
main(args)
  // just run a second time, to repeat all failed builds
  .then(() => main(args))
  .then((res) => process.exit(res));
