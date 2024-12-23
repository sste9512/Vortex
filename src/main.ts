import './util/application.electron';
import getVortexPath from './util/getVortexPath';

import { app, dialog } from 'electron';
import * as path from 'path';
import { DEBUG_PORT, HTTP_HEADER_SIZE } from './constants';

import * as sourceMapSupport from 'source-map-support';
import requireRemap from './util/requireRemap';
// Produce english error messages (windows only atm), otherwise they don't get
// grouped correctly when reported through our feedback system
import * as winapiT from 'winapi-bindings';

import Application from './app/Application';

import type { IPresetStep, IPresetStepCommandLine } from './types/IPreset';

import commandLine, { relaunch } from './util/commandLine';
import { sendReportFile, terminate, toError } from './util/errorHandling';
// ensures tsc includes this dependency
// required for the side-effect!
import './util/exeIcon';
import './util/monkeyPatching';
import './util/webview';

import * as child_processT from 'child_process';
import * as fs from './util/fs';
import presetManager from './util/PresetManager';
import { handleStartupError } from './error_handling_utils';
import { NodeLogging } from './util/logfunctions';
import { WindowAdminService } from './WindowAdminService';
import { NodeSetup } from './app/NodeSetup';









process.on('uncaughtException', handleStartupError);
process.on('unhandledRejection', handleStartupError);

// ensure the cwd is always set to the path containing the exe, otherwise dynamically loaded
// dlls will not be able to load vc-runtime files shipped with Vortex.
process.chdir(getVortexPath('application'));

/* the below would completely restart Vortex to ensure everything is loaded with the cwd
   reset but that doesn't seem to be necessary
// if this is the primary instance, verify we run from the right cwd, otherwise
// vc runtime files might not load correctly
if (!process.argv.includes('--relaunched')
  && (path.normalize(process.cwd()).toLowerCase()
    !== path.normalize(getVortexPath('application')).toLowerCase())) {
  // tslint:disable-next-line:no-var-requires
  const cp: typeof child_processT = require('child_process');
  const args = [].concat(['--relaunched'], process.argv.slice(1));
  const proc = cp.spawn(process.execPath, args, {
    cwd: getVortexPath('application'),
    detached: true,
  });
  app.quit();
}
*/
sourceMapSupport.install();

requireRemap();

NodeSetup.setupEnvironment();

WindowAdminService.filterPathOnWindows();

WindowAdminService.setUILanguageToEnglish();

process.env.Path = process.env.Path + path.delimiter + __dirname;









/*
  use this to do first time setup, that is: code to be run
  only the very first time vortex starts up.
  This functionality was introduced but then we ended up solving
  the problem in a different way that's why this is unused currently
*/
async function firstTimeInit() {}

const SYNC_FEATURES = [
  { switch: 'disable-features', value: 'WidgetLayering' },
  { switch: 'disable-features', value: 'UseEcoQoSForBackgroundProcess' },
];

const NODE_ENV_DEV_PORT = 'remote-debugging-port';
const DEFAULT_LOCALE = 'en';





let application: Application;



/**
 * The main entry point of the application. This function handles the initial
 * setup, configuration, and execution flow of the application based on
 * command-line arguments and environment settings. It parses arguments, sets
 * environment variables, handles GPU configuration, initializes required
 * modules, and starts the application or executes specific commands if needed.
 *
 * @return {Promise<void>} A promise that resolves once the setup and execution
 * flow is complete, or the application exits due to a specific command-line
 * argument or error.
 */
async function main(): Promise<void> {
  const mainArgs = parseCommandLineArgs(process.argv);

  if (mainArgs.report) {
    await sendAndQuit(mainArgs.report);
    return;
  }

  updateEnvironmentVariables();
  configureGPU(mainArgs.disableGPU);
  applyCommandLineFeatures(SYNC_FEATURES);

  if (mainArgs.run !== undefined) {
    await executeRunArgument(mainArgs.run);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    exitDueToInstanceConflict();
    return;
  }

  if (!(await setupCommandLinePresets(mainArgs))) {
    return;
  }

  await initializeFileSystem();

  setupErrorHandling();
  enableDebuggingInDevMode();

  initializeElectronRemoteModule();
  ensureTranslationModule(DEFAULT_LOCALE);

  application = new Application(mainArgs);
}

const handleError = (error: any) => {
  if (Application.shouldIgnoreError(error)) {
    return;
  }

  terminate(toError(error), {});
};


function parseCommandLineArgs(args: string[]): any {
  // Assuming `commandLine` handles the parsing
  return commandLine(args, false);
}



async function sendAndQuit(report: string): Promise<void> {
  await sendReportFile(report);
  app.quit();
}



function updateEnvironmentVariables(): void {
  const NODE_OPTIONS = process.env.NODE_OPTIONS || '';
  process.env.NODE_OPTIONS = `${NODE_OPTIONS} --max-http-header-size=${HTTP_HEADER_SIZE} --no-force-async-hooks-checks`;
}



function configureGPU(enableGPU: boolean): void {
  if (enableGPU) return;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('--disable-software-rasterizer');
  app.commandLine.appendSwitch('--disable-gpu');
}




function applyCommandLineFeatures(
  features: { switch: string; value: string }[],
): void {
  features.forEach(feature =>
    app.commandLine.appendSwitch(feature.switch, feature.value),
  );
}




async function executeRunArgument(scriptPath: string): Promise<void> {
  const childProcess = require('child_process') as typeof child_processT;

  childProcess
    .spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: 'inherit',
      detached: true,
    })
    .on('error', error => {
      dialog.showErrorBox('Failed to run script', error.message);
    });

  app.quit();
}




function exitDueToInstanceConflict(): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('--in-process-gpu');
  app.commandLine.appendSwitch('--disable-software-rasterizer');
  app.quit();
}




async function setupCommandLinePresets(mainArgs: any): Promise<boolean> {
  const presetProcessed = presetManager.now(
    'commandline',
    (step: IPresetStep): Promise<void> => {
      (step as IPresetStepCommandLine).arguments.forEach(arg => {
        mainArgs[arg.key] = arg.value ?? true;
      });
      return Promise.resolve();
    },
  );

  if (!presetProcessed) {
    presetManager.on('commandline', (): Promise<void> => {
      relaunch();
      return new Promise(() => {
        /* block indefinitely */
      });
    });
  }

  return presetProcessed;
}



async function initializeFileSystem(): Promise<void> {
  try {
    await fs.statAsync(getVortexPath('userData'));
  } catch {
    await firstTimeInit();
  }
}



function setupErrorHandling(): void {
  process.on('uncaughtException', handleError);
  process.on('unhandledRejection', handleError);
}




function enableDebuggingInDevMode(): void {
  if (
    process.env.NODE_ENV === 'development' &&
    !app.commandLine.hasSwitch(NODE_ENV_DEV_PORT)
  ) {
    NodeLogging.printSuccess('Enabling debugging on port' + DEBUG_PORT);
    app.commandLine.appendSwitch(NODE_ENV_DEV_PORT, DEBUG_PORT);
  }
}




function initializeElectronRemoteModule(): void {
  require('@electron/remote/main').initialize();
}



function ensureTranslationModule(defaultLocale: string): void {
  let fixedT = require('i18next').getFixedT(defaultLocale);

  try {
    fixedT('dummy');
  } catch {
    // Fallback for incorrect i18n initialization
    fixedT = (input: string) => input;
  }
}

main();
