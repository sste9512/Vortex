// noinspection JSAnnotator

'use strict';

const Promise = require('bluebird');
const fileStream = require('fs-extra');
const path = require('path');
const glob = require('glob');
const { exec } = require('child_process')

const data = require('./InstallAssets.json');

const globOptions = { matchBase: true, globstar: true };

if (process.argv.length < 3) {
  process.exit(1);
}
const tgt = process.argv[2];

let childProcesses = [];
let copies = -1;

let status = 0;

// run other, independent commands concurrently to speed things up.
for (let spawn of data.spawn) {
  // Check if the current target (tgt) matches the spawn's target list
  if (spawn.target.indexOf(tgt) === -1) {
    continue;
  }

  // Construct the command line to be executed
  const cmdline = spawn.executable + ' ' + spawn.arguments.join(' ');

  // Spawn a child process to execute the command
  const child = exec(spawn.executable + ' ' + spawn.arguments.join(' '), {
    stdio: [0, 1, 2], // Use standard input, output, and error streams
    env: Object.assign({}, process.env, spawn.env), // Merge the current environment with spawn-specific environment variables
  });

  // Log the information about the spawned process
  console.log(`[INFO] Spawned process: ${cmdline}`);

  // Listen for and log data received from the child process's stdout
  child.stdout.on('data', (output) => {
    console.log(`[STDOUT] ${spawn.executable}: ${output}`);
  });

  // Listen for and log data received from the child process's stderr
  child.stderr.on('data', (output) => {
    console.error(`[STDERR] Error in ${spawn.executable}: ${output}`);
  });

  // Handle the process close event and log the exit code
  child.on('close', (code) => {
    if (code !== 0) {
      status = 1; // Update the status to indicate an error
      console.error(`[ERROR] Process ${spawn.executable} exited with code ${code}`);
    } else {
      console.log(`[INFO] Process ${spawn.executable} finished successfully with code ${code}`);
    }
  });

  // Add the current process to the list of child processes
  childProcesses.push(spawn.executable);

  // Handle the process exit event and update the child processes list
  child.on('exit', () => {
    console.log(`[INFO] Process ${spawn.executable} exited.`);
    childProcesses = childProcesses.filter((proc) => proc !== spawn.executable);
  });
}

/**
 * Waits for all child processes to finish execution and for the `copies` counter to reach zero.
 * This function ensures that asynchronous processes are completed before proceeding.
 *
 * @return {Promise<void>} A promise that resolves when all child processes have concluded and `copies` equals zero.
 */
function waitForProcesses() {
  let resolve;

  const processHandler = () => {
    if ((childProcesses.length > 0) || (copies !== 0)) {
      setTimeout(processHandler, 100);
    } else {
      resolve();
    }
  }

  return new Promise((resolveIn, reject) => {
    resolve = resolveIn;
    setTimeout(processHandler, 100);
  });
}


/**
 * Processes the `data.copy` array, filtering and copying files as described in the configuration.
 * Each file entry in `data.copy` is validated, and the source files are discovered using glob patterns.
 * Identified files are copied to their respective target locations, preserving or modifying their names
 * based on the configuration.
 *
 * @return {Promise<void>} Resolves when all file copy operations are completed.
 */
Promise.mapSeries(data.copy, file => {
  // Check if the current target (tgt) matches the file's target list
  if (file.target.indexOf(tgt) === -1) {
    return;
  }

  // Discover files to copy matching the `srcPath` glob
  return new Promise((resolve, reject) => {
    try {
      const files = glob.sync(file.srcPath, globOptions);
      copies = copies === -1 ? files.length : (copies += files.length);
      resolve(files);
    } catch (globErr) {
      reject(new Error('glob failed: ' + globErr));
    }
  })
    .then(files =>
      // Map each discovered file and process its copy operation
      Promise.map(files, globResult => {
        // Generate the target path by removing specified prefixes and applying renames if configured
        let globTarget = path.join(
          ...globResult.split(/[\/\\]/).slice(file.skipPaths),
        );
        if (file.rename) {
          globTarget = path.join(path.dirname(globTarget), file.rename);
        }
        const targetFile = path.join(tgt, file.outPath, globTarget);

        // Ensure target directory exists and copy the file
        return fileStream
          .ensureDir(path.dirname(targetFile)) // Guarantee the directory for the target file
          .then(() => fileStream.copy(globResult, targetFile)) // Copy the file to the target location
          .then(() => ({
            Status: 'Copied',
            Source: globResult,
            Target: targetFile,
          })) // Success response for a copied file
          .catch(copyErr => ({
            Status: 'Failed',
            Source: globResult,
            Target: targetFile,
            Error: copyErr.message,
          })) // Error response if the copy fails
          .finally(() => {
            --copies; // Decrement the copy counter to track progress
          });
      })
        .then(results => {
          // Print the results of the operation as a table
          console.table(results);
        }),
    );
})
  .then(() => waitForProcesses()); // Ensure all asynchronous processes are completed before resolution
