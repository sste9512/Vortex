'use strict';

const Promise = require('bluebird');
const fs = require('fs-extra');
const path = require('path');
const glob = require('glob');
const exec = require('child_process').exec;

const data = require('./InstallAssets.json');

const globOptions = { matchBase: true, globstar: true };

if (process.argv.length < 3) {
  process.exit(1);
}
const tgt = process.argv[2];

let childProcesses = [];
let copies = -1;

let status = 0;

// run other, independend commands concurrently to speed things up.
for (let spawn of data.spawn) {
  if (spawn.target.indexOf(tgt) === -1) {
    continue;
  }

  const cmdline = spawn.executable + ' ' + spawn.arguments.join(' ');
  const child = exec(spawn.executable + ' ' + spawn.arguments.join(' '), {
    stdio: [0, 1, 2],
    env: Object.assign({}, process.env, spawn.env),
  });
  console.log(`[INFO] Spawned process: ${cmdline}`);
  child.stdout.on('data', (output) => {
    console.log(`[STDOUT] ${spawn.executable}: ${output}`);
  });
  child.stderr.on('data', (output) => {
    console.error(`[STDERR] Error in ${spawn.executable}: ${output}`);
  });
  child.on('close', (code) => {
    if (code !== 0) {
      status = 1;
      console.error(`[ERROR] Process ${spawn.executable} exited with code ${code}`);
    } else {
      console.log(`[INFO] Process ${spawn.executable} finished successfully with code ${code}`);
    }
  });
  childProcesses.push(spawn.executable);
  child.on('exit', () => {
    console.log(`[INFO] Process ${spawn.executable} exited.`);
    childProcesses = childProcesses.filter((proc) => proc !== spawn.executable);
  });
}

function waitForProcesses() {
  let resolve;

  const cb = () => {
    if ((childProcesses.length > 0) || (copies !== 0)) {
      setTimeout(cb, 100);
    } else {
      resolve();
    }
  }

  return new Promise((resolveIn, reject) => {
    resolve = resolveIn;
    setTimeout(cb, 100);
  });
}

// copy files
Promise.mapSeries(data.copy, file => {
  if (file.target.indexOf(tgt) === -1) {
    return;
  }

  return new Promise((resolve, reject) => {
    try {
      const files = glob.sync(file.srcPath, globOptions);
      copies = copies === -1 ? files.length : (copies += files.length);
      resolve(files);
    } catch (globErr) {
      reject(new Error('glob failed: ' + globErr));
    }
  }).then(files =>
    Promise.map(files, globResult => {
      let globTarget = path.join(
        ...globResult.split(/[\/\\]/).slice(file.skipPaths),
      );
      if (file.rename) {
        globTarget = path.join(path.dirname(globTarget), file.rename);
      }
      const targetFile = path.join(tgt, file.outPath, globTarget);

      return fs
        .ensureDir(path.dirname(targetFile))
        .then(() => fs.copy(globResult, targetFile))
        .then(() => ({
          Status: 'Copied',
          Source: globResult,
          Target: targetFile,
        }))
        .catch(copyErr => ({
          Status: 'Failed',
          Source: globResult,
          Target: targetFile,
          Error: copyErr.message,
        }))
        .finally(() => {
          --copies;
        });
    }).then(results => {
      console.table(results);
    }),
  );
})
  .then(() => waitForProcesses());
