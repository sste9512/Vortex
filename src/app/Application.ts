/* eslint-disable max-lines-per-function */
import { setApplicationVersion, setInstanceId, setWarnedAdmin } from '../actions/app';
import { NEXUS_DOMAIN } from '../extensions/nexus_integration/constants';
import { STATE_BACKUP_PATH } from '../reducers/index';
import { ThunkStore } from '../types/IExtensionContext';
import type { IPresetStep, IPresetStepHydrateState } from '../types/IPreset';
import { IState } from '../types/IState';
import { getApplication } from '../util/application';
import commandLine, { IParameters, ISetItem, relaunch } from '../util/commandLine';
import {
  DataInvalid,
  DocumentsPathMissing,
  ProcessCanceled,
  UserCanceled,
} from '../util/CustomErrors';
import * as develT from '../util/devel';
import {
  didIgnoreError,
  disableErrorReport,
  getVisibleWindow,
  setOutdated,
  setWindow,
  terminate,
  toError,
} from '../util/errorHandling';
import ExtensionManagerT from '../util/ExtensionManager';
import { validateFiles } from '../util/fileValidation';
import * as fs from '../util/fs';
import getVortexPath, { setVortexPath } from '../util/getVortexPath';
import lazyRequire from '../util/lazyRequire';
import LevelPersist, { DatabaseLocked } from '../util/LevelPersist';
import { log, setLogPath, setupLogging } from '../util/log';
import { prettifyNodeErrorMessage, showError } from '../util/message';
import migrate from '../util/migrate';
import presetManager from '../util/PresetManager';
import { StateError } from '../util/reduxSanity';
import startupSettings from '../util/startupSettings';
import {
  allHives,
  createFullStateBackup,
  createVortexStore,
  currentStatePath,
  extendStore,
  finalizeStoreWrite,
  importState,
  insertPersistor,
  markImported,
  querySanitize,
} from '../util/store';
import SubPersistor from '../util/SubPersistor';
import { isMajorDowngrade, replaceRecursive, spawnSelf, timeout, truthy } from '../util/util';

import { addNotification, setCommandLine, showDialog } from '../actions';

import MainWindowT from './MainWindow';
import SplashScreenT from './SplashScreen';
import TrayIconT from './TrayIcon';

import * as msgpackT from '@msgpack/msgpack';
import BPromise from 'bluebird';
import Bluebird from 'bluebird';
import crashDumpT from 'crash-dump';
import { app, crashReporter as crashReporterT, dialog, ipcMain, protocol, shell } from 'electron';
import contextMenu from 'electron-context-menu';
import * as _ from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as permissionsT from 'permissions';
import * as semver from 'semver';
import * as uuidT from 'uuid';

import * as winapiT from 'winapi-bindings';
import { WindowAdminService } from '../window-admin-service';
import { Result } from '../models/result';
import { NodeLogging } from '../util/logfunctions';
import isAdmin from 'is-admin';
import { InstallationService } from '../installation-service';
import { FileService } from '../file-service';
import { IApplication } from './IApplication';
import { injectable, injectWithTransform, singleton } from 'tsyringe';
import Transform from 'tsyringe/dist/typings/types/transform';
import * as Electron from 'electron';



const uuid = lazyRequire<typeof uuidT>(() => require('uuid'));
const permissions = lazyRequire<typeof permissionsT>(() =>
  require('permissions'),
);
const winapi = lazyRequire<typeof winapiT>(() => require('winapi-bindings'));

const STATE_CHUNK_SIZE = 128 * 1024;

function last(array: any[]): any {
  if (array.length === 0) {
    return undefined;
  }
  return array[array.length - 1];
}

export class WeakRefAccessor<T extends object> {
     public getRef(reference: T){
         return new WeakRef<T>(reference);
     }
}

export class WeakRefTransformer<T extends object> implements Transform<WeakRefAccessor<T>, WeakRef<T>>{
  transform(incoming: WeakRefAccessor<T>, args: any): WeakRef<T> {
    return incoming.getRef(args);
  }
}





/**
 * Represents the main Application class which initializes and manages the core functionalities
 * of the application, including setup, error handling, UI, and event management.
 */
@singleton()
class Application implements IApplication {


  // Move to configuration
  private appBasePath: string;
  // Move to configuration
  private startupLogPath: string;
  // Move to configuration
  private mDeinitCrashDump: () => void;
  private thunkStore: ThunkStore<IState>;
  private levelPersistors: LevelPersist[] = [];

  private applicationArguments: IParameters;
  private mainWindowReference: WeakRef<MainWindowT>;

  // Move to configuration
  private mExtensions: ExtensionManagerT;
  // Move to electron/ui functions
  private trayIcons: TrayIconT;

  // Move to application service
  private mFirstStart: boolean = false;

  // Move to electron/ui functions
  private splashScreenWeakRef: WeakRef<SplashScreenT>;


  constructor(parameters: IParameters, @injectWithTransform(WeakRefAccessor, WeakRefTransformer<Electron.App>, app) private appReference : Electron.App) {

  }

  public takeInputs (parameters: IParameters) {
    this.applicationArguments = parameters;

    // Initialize IPC event handlers
    ipcMain.on('show-window', this.onShowWindow);

    // Set environment variables
    process.env['UV_THREADPOOL_SIZE'] = (os.cpus().length * 1.5).toString();
    app.commandLine.appendSwitch(
      'js-flags',
      `--max-old-space-size=${parameters.maxMemory || 4096}`,
    );

    // Initialize paths and directories
    this.appBasePath = app.getPath('userData');
    const directoriesResult = this.ensureRequiredDirectories();
    if (directoriesResult.ok) {
      NodeLogging.printSuccess('Vortex data directory' + this.appBasePath);
    }

    // Setup Crash Reporting
    this.initializeCrashReporting();

    // Setup logging
    setupLogging(this.appBasePath, process.env.NODE_ENV === 'development');

    // Application-specific initialization
    this.bindAppEvents(parameters);
  }




  /**
   * Cleans up resources and performs necessary shutdown operations for the application.
   *
   * This method removes IPC listeners, disposes of persistors, clears environment variables,
   * and releases any references to application components such as windows, tray icons, and splash screens.
   *
   * @return {Promise<void>} A promise that resolves when the cleanup process is complete.
   */
  public async cleanup(): Promise<void> {
    try {

      // Cleanup IPC main listener
      ipcMain.removeListener('show-window', this.onShowWindow);

      // Dispose and clean level persistors
      for (const persistor of this.levelPersistors) {
        try {
          await persistor.close();
        } catch (e) {
          NodeLogging.printErrorAsGrid(
            `Error while closing persistor: ${e.message}`,
          );
        }
      }
      this.levelPersistors = [];

      // Cleanup main window reference
      if (this.mainWindowReference?.deref()) {
        //this.mMainWindow.deref()?.destroy();
      }
      this.mainWindowReference = undefined as any;

      // Cleanup tray icon
      if (this.trayIcons) {
        //this.mTray.
        this.trayIcons = undefined!;
      }

      this.splashScreenWeakRef.deref().getHandle().close();
      this.splashScreenWeakRef = undefined as any;
      delete this.splashScreenWeakRef;

      // Clear environment variables
      delete process.env['UV_THREADPOOL_SIZE'];
      delete process.env.CRASH_REPORTING;

      // Perform additional cleanup for extensions
      // if (this.mExtensions) {
      //   try {
      //     this.mExtensions.deinitialize();
      //   } catch (e) {
      //     NodeLogging.printErrorAsGrid(
      //       `Error while deinitializing extensions: ${e.message}`,
      //     );
      //   }
      //   this.mExtensions = undefined!;
      // }

      // Close persistent stores or database
      //this.thunkStore?.dispatch(terminate());
    } catch (error) {
      NodeLogging.printErrorAsGrid(`Error during Application cleanup: ${error.message}`);
    }
  }





  /**
   * Handles the event to show the main application window.
   * Determines whether to start the window minimized or in its normal state
   * based on the provided arguments.
   *
   * @return {void | undefined} Returns void or undefined after showing the main window.
   */
  private onShowWindow(): void | undefined {
    return this.showMainWindow(this.applicationArguments?.startMinimized);
  }




  // Extracted helper methods
  private ensureRequiredDirectories(): Result<void> {
    try {
      const temporaryPath = this.getAndEnsureTempPath();
      fs.ensureDirSync(path.join(temporaryPath, 'dumps'));
      this.startupLogPath = path.join(temporaryPath, 'startup.log');

      // Ensure startup log existence
      try {
        fs.statSync(this.startupLogPath);
        process.env.CRASH_REPORTING =
          Math.random() > 0.5 ? 'vortex' : 'electron';
      } catch {
        NodeLogging.printErrorAsGrid('Could not find startup log file');
      }

      return { error: undefined, ok: undefined, value: undefined };
    } catch (error) {
      return { ok: undefined, value: undefined, error: error };
    }
  }





  private getAndEnsureTempPath(): string {
    setVortexPath('temp', () => path.join(getVortexPath('userData'), 'temp'));
    const temporaryPath = getVortexPath('temp');
    fs.ensureDirSync(temporaryPath);
    return temporaryPath;
  }




  private initializeCrashReporting(): void {
    const temporaryPath = getVortexPath('temp');

    if (process.env.CRASH_REPORTING === 'electron') {
      const crashReporter: typeof crashReporterT =
        require('electron').crashReporter;
      crashReporter.start({
        productName: 'Vortex',
        uploadToServer: false,
        submitURL: '',
      });
      app.setPath('crashDumps', path.join(temporaryPath, 'dumps'));
    } else if (process.env.CRASH_REPORTING === 'vortex') {
      const vortexCrashDump: typeof crashDumpT = require('crash-dump').default;
      this.mDeinitCrashDump = vortexCrashDump(
        path.join(temporaryPath, 'dumps', `crash-main-${Date.now()}.dmp`),
      );
    }
  }

  // TODO: Move to electron utils
  private setupContextMenu() {
    contextMenu({
      showCopyImage: false,
      showLookUpSelection: false,
      showSaveImageAs: false,
      showInspectElement: false,
      showSearchWithGoogle: false,
      shouldShowMenu: (
        event: Electron.Event,
        params: Electron.ContextMenuParams,
      ) => {
        // currently only offer menu on selected text
        return params.selectionText.length > 0;
      },
    });
  }

  /**
   * Initializes and starts the UI by creating the main application window, setting up APIs,
   * and applying necessary configurations. This method also processes any ignored errors
   * and appropriately sends notifications to the UI.
   *
   * @return {Promise<void>} A promise that resolves when the UI has been successfully started,
   * including the main window creation and API setup.
   */
  protected startUi(): Bluebird<void> {
    const MainWindow = require('./MainWindow').default;
    this.mainWindowReference = new WeakRef<MainWindowT>(
      new MainWindow(this.thunkStore, this.applicationArguments.inspector),
    );
    //this.mMainWindow = new MainWindow(this.mStore, this.applicationArguments.inspector);
    log('debug', 'creating main window');
    return this.mainWindowReference
      .deref()
      .create(this.thunkStore)
      .then(webContents => {
        log('debug', 'window created');
        this.mExtensions.setupApiMain(this.thunkStore, webContents);
        setOutdated(this.mExtensions.getApi());
        // in the past we would process some command line arguments the same as we do when
        // they get passed in from a second instance but that was inconsistent
        // because we don't use most arguments from secondary instances and the
        // rest get handled by the extension they are intended for.
        // so now "applyArguments()" is only intended for forwarding messages from
        // secondary instances

        if (didIgnoreError()) {
          webContents.send('did-ignore-error', true);
        }
        return Promise.resolve();
      });
  }

  private async startSplash(): Promise<Result<SplashScreenT>> {
    try {
      const SplashScreenModule = require('./SplashScreen').default;

      const splashScreenInstance: SplashScreenT = new SplashScreenModule();
      this.splashScreenWeakRef = new WeakRef<SplashScreenT>(
        splashScreenInstance,
      );

      const isCreated = await splashScreenInstance.create(
        this.applicationArguments.disableGPU,
      );

      setWindow(splashScreenInstance.getHandle());

      return { ok: true, value: splashScreenInstance };
    } catch (initializationError) {
      return { ok: false, error: initializationError };
    }

    // return splash.create(this.applicationArguments.disableGPU).then(() => {
    //   setWindow(splash.getHandle());
    //   return splash;
    // });
  }

  /**
   * Sets up and binds application-level event handlers to manage the app's lifecycle and behavior.
   *
   * @param {IParameters} args Configuration or parameters needed for initializing app events.
   * @return {void} Does not return a value.
   */
  private bindAppEvents(args: IParameters): void {
    app.on('window-all-closed', this.onWindowsAllClosed);
    app.on('activate', this.onActivate);
    app.on('second-instance', this.handleAppSecondInstance);
    app.whenReady().then(this.onApplicationReady);
    app.on('web-contents-created', this.onWebContentsCreated);
  }

  /**
   * Handles the event when all application windows are closed.
   * Performs necessary cleanup tasks such as logging, tray disposal,
   * crash dump initialization, and application termination depending on the platform.
   *
   * @return {Promise<void>} A promise that resolves when all cleanup tasks are completed.
   */
  private async onWindowsAllClosed(): Promise<void> {
    log('info', 'Vortex closing');
    await finalizeStoreWrite();
    log('info', 'clean application end');
    if (this.trayIcons !== undefined) {
      this.trayIcons.close();
    }
    if (this.mDeinitCrashDump !== undefined) {
      this.mDeinitCrashDump();
    }
    if (process.platform !== 'darwin') {
      //TODO: Add cleanup here
      app.quit();
    }
  }

  /**
   * Activates the main window by creating it through a dereferenced reference,
   * if the main window reference is defined.
   *
   * @return {Promise<void>} A promise that resolves once the main window creation process is completed.
   */
  private async onActivate(): Promise<void> {
    if (this.mainWindowReference !== undefined) {
      await this.mainWindowReference.deref().create(this.thunkStore);
    }
  }

  /**
   * Handles the initialization of web contents when they are created.
   *
   * @param {Electron.Event} event - The event object associated with the web contents creation.
   * @param {Electron.WebContents} contents - The web contents instance being created.
   * @return {void} There is no return value from this method.
   */
  private onWebContentsCreated(
    event: Electron.Event,
    contents: Electron.WebContents,
  ): void {
    // tslint:disable-next-line:no-submodule-imports
    require('@electron/remote/main').enable(contents);
    contents.on('will-attach-webview', this.attachWebView);
  }

  /**
   * A function to configure and secure webview creation by modifying its webPreferences.
   *
   * This function ensures the webview is not created with potentially unsafe settings
   * by removing the preload and preloadURL properties from the provided `webPreferences`.
   * Additionally, it enforces `nodeIntegration` to be disabled for security reasons.
   *
   * @param {Electron.Event} event - The event object associated with the webview creation.
   * @param webPreferences
   * */
  private attachWebView = (
    event: Electron.Event,
    webPreferences: Electron.WebPreferences & { preloadURL: string },
  ) => {
    // disallow creation of insecure webviews

    delete webPreferences.preload;
    delete webPreferences.preloadURL;

    webPreferences.nodeIntegration = false;
  };


  private handleAppSecondInstance(event: Event, secondaryArgv: string[]) {
    log('debug', 'getting arguments from second instance', secondaryArgv);
    this.applyArguments(commandLine(secondaryArgv, true));
  }

  /**
   * Handles the initialization of the application when it is ready.
   *
   * This method determines the appropriate user data path, logs relevant messages,
   * sets up handling for 'nxm://' protocol, and processes application arguments
   * (get, set, or del) to handle specific functionality. If none of these arguments
   * are provided, the method proceeds with a regular application start.
   *
   * @return {Promise<void>} Resolves when the application startup tasks are completed
   *                         or the application is terminated, ensuring all initialization
   *                         steps are appropriately handled.
   */
  async onApplicationReady(): Promise<void> {
    const vortexPath =
      process.env.NODE_ENV === 'development' ? 'vortex_devel' : 'vortex';

    let userResult = WindowAdminService.tryFindUserData(
      this.applicationArguments,
      vortexPath,
    );

    let userData: string = '';

    if (userResult.ok) {
      NodeLogging.printSuccess('Using user data path: ' + userResult.value);
      userData = path.join(userResult.value, currentStatePath);
    }
    if (userResult.ok == false) {
      NodeLogging.printErrorAsGrid(userResult.error.message);
    }

    // handle nxm:// internally
    protocol.registerHttpProtocol('nxm', (request, callback) => {
      const cfgFile: IParameters = { download: request.url };
      this.applyArguments(cfgFile);
    });

    let startupMode: Bluebird<void | Awaited<void>[]>;
    if (this.applicationArguments.get) {
      startupMode = this.handleGet(this.applicationArguments.get, userData);
    } else if (this.applicationArguments.set) {
      startupMode = this.handleSet(this.applicationArguments.set, userData);
    } else if (this.applicationArguments.del) {
      startupMode = this.handleDel(this.applicationArguments.del, userData);
    }

    if (startupMode !== undefined) {
      startupMode.then(() => {
        app.quit();
      });
    } else {
      await this.regularStart(this.applicationArguments);
    }
  }


  /**
   * Determines whether a given error should be ignored based on specific conditions.
   *
   * @param {any} error The error object to evaluate.
   * @param {any} [promise] Optional. The promise associated with the error, if applicable.
   * @return {boolean} Returns true if the error should be ignored, otherwise false.
   */
  public static shouldIgnoreError(error: any, promise?: any): boolean {
    if (error instanceof UserCanceled) {
      return true;
    }

    if (!truthy(error)) {
      log('error', 'empty error unhandled', {
        wasPromise: promise !== undefined,
      });
      return true;
    }

    if (error.message === 'Object has been destroyed') {
      // This happens when Vortex crashed because of something else so there is no point
      // reporting this, it might otherwise obfuscate the actual problem
      return true;
    }

    // this error message appears to happen as the result of some other problem crashing the
    // renderer process, so all this may do is obfuscate what's actually going on.
    if (
      error.message.includes(
        'Error processing argument at index 0, conversion failure from',
      )
    ) {
      return true;
    }

    if (
      [
        'net::ERR_CONNECTION_RESET',
        'net::ERR_CONNECTION_ABORTED',
        'net::ERR_ABORTED',
        'net::ERR_CONTENT_LENGTH_MISMATCH',
        'net::ERR_SSL_PROTOCOL_ERROR',
        'net::ERR_HTTP2_PROTOCOL_ERROR',
        'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
      ].includes(error.message) ||
      ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error.code)
    ) {
      log('warn', 'network error unhandled', error.stack);
      return true;
    }

    if (
      ['EACCES', 'EPERM'].includes(error.errno) &&
      error.path !== undefined &&
      error.path.indexOf('vortex-setup') !== -1
    ) {
      // It's wonderous how electron-builder finds new ways to be more shit without even being
      // updated. Probably caused by node update
      log('warn', 'suppressing error message', {
        message: error.message,
        stack: error.stack,
      });
      return true;
    }

    return false;
  }

  private generateHandleError() {
    return (error: any, promise?: any) => {
      if (Application.shouldIgnoreError(error, promise)) {
        return;
      }

      terminate(toError(error), this.thunkStore.getState());
    };
  }

  /**
   * Initializes the application startup process, including checks on the user environment, file validation,
   * creation of the application store, user interface setup, and handling of errors during the startup sequence.
   *
   * @param {IParameters} args - The startup parameters that may include options like restoring a previous state,
   *                              merging data, or starting the application in a minimized state.
   * @return {BPromise<void>} A Bluebird promise that resolves when the application has completed initialization
   *                          successfully or rejects if an error occurs during the startup process.
   */
  private regularStart(args: IParameters): BPromise<void> {
    let splash: SplashScreenT;
    return (
      fs
        .writeFileAsync(this.startupLogPath, new Date().toUTCString())
        .catch(() => null)
        .tap(() => {
          log('info', '--------------------------');
          log('info', 'Vortex Version', getApplication().version);
          log('info', 'Parameters', process.argv.join(' '));
        })
        .then(() => this.testUserEnvironment())
        .then(() => this.validateFiles())
        .then(() =>
          args?.startMinimized === true
            ? Promise.resolve(undefined)
            : this.startSplash(),
        )
        // start initialization
        .tap(splashIn =>
          splashIn !== undefined
            ? log('debug', 'showing splash screen')
            : log('debug', 'starting without splash screen'),
        )
        .then(splashIn => {
          splash = splashIn;
          return this.createStore(args.restore, args.merge).catch(
            DataInvalid,
            onDataInvalidErrorHandler,
          );

          function onDataInvalidErrorHandler(err: { message: any }) {
            NodeLogging.printErrorAsGrid(err.message);
            log('error', 'store data invalid', err.message);
            dialog
              .showMessageBox(getVisibleWindow(), {
                type: 'error',
                buttons: ['Continue'],
                title: 'Error',
                message: 'Data corrupted',
                detail:
                  'The application state which contains things like your Vortex ' +
                  'settings, meta data about mods and other important data is ' +
                  "corrupted and can't be read. This could be a result of " +
                  'hard disk corruption, a power outage or something similar. ' +
                  'Vortex will now try to repair the database, usually this ' +
                  'should work fine but please check that settings, mod list and so ' +
                  'on are ok before you deploy anything. ' +
                  'If not, you can go to settings->workarounds and restore a backup ' +
                  "which shouldn't lose you more than an hour of progress.",
              })
              .then(() => this.createStore(args.restore, args.merge, true));
          }
        })
        .tap(() => log('debug', 'checking admin rights'))
        .then(() => this.warnAdmin())
        .tap(() => log('debug', 'checking how Vortex was installed'))
        .then(() => InstallationService.identifyInstallType(this.thunkStore))
        .tap(() => log('debug', 'checking if migration is required'))
        .then(() => this.checkUpgrade())
        .tap(() => log('debug', 'setting up error handlers'))
        .then(() => {
          // as soon as we have a store, install an extended error handler that has
          // access to application state
          const handleError = this.generateHandleError();
          process.removeAllListeners('uncaughtException');
          process.removeAllListeners('unhandledRejection');
          process.on('uncaughtException', handleError);
          process.on('unhandledRejection', handleError);
        })
        .then(() => {
          this.thunkStore.dispatch(setCommandLine(args));
        })
        .then(() => this.initDevel())
        .tap(() => log('debug', 'starting user interface'))
        .then(() => {
          this.setupContextMenu();
          return Promise.resolve();
        })
        .then(() => this.startUi())
        .tap(() => log('debug', 'setting up tray icon'))
        .then(() => this.createTray())
        // end initialization
        .tap(() => {
          if (splash !== undefined) {
            log('debug', 'removing splash screen');
          }
        })
        .then(() => {
          this.connectTrayAndWindow();
          return splash !== undefined ? splash.fadeOut() : Promise.resolve();
        })
        .tapCatch(err => log('debug', 'quitting with exception', err.message))
        .catch(UserCanceled, () => app.exit())
        .catch(ProcessCanceled, () => {
          // TODO: Add cleanup here
          app.quit();
        })
        .catch(DocumentsPathMissing, () =>
          dialog
            .showMessageBox(getVisibleWindow(), {
              type: 'error',
              buttons: ['Close', 'More info'],
              defaultId: 1,
              title: 'Error',
              message: 'Startup failed',
              detail:
                'Your "My Documents" folder is missing or is ' +
                'misconfigured. Please ensure that the folder is properly ' +
                'configured and accessible, then try again.',
            })
            .then(response => {
              if (response.response === 1) {
                shell.openExternal(
                  `https://wiki.${NEXUS_DOMAIN}/index.php/Misconfigured_Documents_Folder`,
                );
              }
              app.quit();
            }),
        )
        .catch(DatabaseLocked, () => {
          dialog.showErrorBox(
            'Startup failed',
            'Vortex seems to be running already. ' +
              "If you can't see it, please check the task manager.",
          );
          app.quit();
        })
        .catch({ code: 'ENOSPC' }, this.handleDiscDriveFull)
        .catch(this.handleCascadeErrors)
        .finally(async () => await FileService.deleteFile(this.startupLogPath)) // fs.removeAsync(this.mStartupLogPath).catch(() => null))
    );
  }

  private handleDiscDriveFull() {
    dialog.showErrorBox(
      'Startup failed',
      'Your system drive is full. ' +
        'You should always ensure your system drive has some space free (ideally ' +
        'at least 10% of the total capacity, especially on SSDs). ' +
        "Vortex can't start until you have freed up some space.",
    );
    app.quit();
  }

  private handleCascadeErrors(err: { stack: any; message: any }) {
    try {
      if (err instanceof Error) {
        const pretty = prettifyNodeErrorMessage(err);
        const details = pretty.message.replace(
          /{{ *([a-zA-Z]+) *}}/g,
          (m, key) => pretty.replace?.[key] || key,
        );
        terminate(
          {
            message: 'Startup failed',
            details,
            code: pretty.code,
            stack: err.stack,
          },
          this.thunkStore !== undefined ? this.thunkStore.getState() : {},
          pretty.allowReport,
        );
      } else {
        terminate(
          {
            message: 'Startup failed',
            details: err.message,
            stack: err.stack,
          },
          this.thunkStore !== undefined ? this.thunkStore.getState() : {},
        );
      }
    } catch (err) {
      // nop
    }
  }

  private warnAdmin(): BPromise<void> {
    const state: IState = this.thunkStore.getState();
    return timeout(BPromise.resolve(isAdmin()), 1000).then(admin => {
      if (admin === undefined || !admin) {
        return Promise.resolve();
      }
      log('warn', 'running as administrator');
      if (state.app.warnedAdmin > 0) {
        return Promise.resolve();
      }
      return WindowAdminService.isUACEnabled().then(uacEnabled =>
        dialog
          .showMessageBox(getVisibleWindow(), {
            title: 'Admin rights detected',
            message:
              `Vortex has detected that it is being run with administrator rights. It is strongly 
              advised to not run any application with admin rights as adverse effects may include 
              permission issues or even security risks. Continue at your own risk` +
              (!uacEnabled
                ? `\n\nPlease note: User Account Control (UAC) notifications are disabled in your 
                  operating system.  We strongly recommend you re-enable these to avoid file permissions 
                  issues and potential security risks.`
                : ''),
            buttons: ['Quit', 'Ignore'],
            noLink: true,
          })
          .then(result => {
            if (result.response === 0) {
              app.quit();
            } else {
              this.thunkStore.dispatch(setWarnedAdmin(1));
              return Promise.resolve();
            }
          }),
      );
    });
  }

  checkUpgrade(): BPromise<void> {
    const currentVersion = getApplication().version;
    return this.migrateIfNecessary(currentVersion).then(() => {
      this.thunkStore.dispatch(setApplicationVersion(currentVersion));
      return BPromise.resolve();
    });
  }

  private migrateIfNecessary(currentVersion: string): BPromise<void> {
    const state: IState = this.thunkStore.getState();
    const lastVersion = state.app.appVersion || '0.0.0';

    if (this.mFirstStart || process.env.NODE_ENV === 'development') {
      // don't check version change in development builds or on first start
      return BPromise.resolve();
    }

    if (isMajorDowngrade(lastVersion, currentVersion)) {
      if (
        dialog.showMessageBoxSync(getVisibleWindow(), {
          type: 'warning',
          title: 'Downgrade detected',
          message: `You're using a version of Vortex that is older than the version you ran previously. 
        Active version: (${currentVersion}) Previously run: (${lastVersion}). Continuing to run this 
        older version may cause irreversible damage to your application state and setup. Continue at your own risk. `,
          buttons: ['Quit', 'Continue at your own risk'],
          noLink: true,
        }) === 0
      ) {
        app.quit();
        return BPromise.reject(new UserCanceled());
      }
    } else if (semver.gt(currentVersion, lastVersion)) {
      log('info', 'Vortex was updated, checking for necessary migrations');
      return migrate(this.thunkStore, getVisibleWindow())
        .then(() => {
          return Promise.resolve();
        })
        .catch(
          err =>
            !(err instanceof UserCanceled) && !(err instanceof ProcessCanceled),
          (err: Error) => {
            dialog.showErrorBox(
              'Migration failed',
              'The migration from the previous Vortex release failed. ' +
                'Please resolve the errors you got, then try again.',
            );
            app.exit(1);
            return Promise.reject(new ProcessCanceled('Migration failed'));
          },
        );
    }
    return BPromise.resolve();
  }

  private splitPath(statePath: string): string[] {
    return statePath
      .match(/(\\.|[^.])+/g)
      .map(input => input.replace(/\\(.)/g, '$1'));
  }

  private handleGet(
    getPaths: string[] | boolean,
    dbpath: string,
  ): BPromise<void> {
    if (typeof getPaths === 'boolean') {
      fs.writeSync(1, 'Usage: vortex --get <path>\n');
      return;
    }

    let persist: LevelPersist;

    return LevelPersist.create(dbpath)
      .then(persistIn => {
        persist = persistIn;
        return persist.getAllKeys();
      })
      .then(keys => {
        return Promise.all(
          getPaths.map(getPath => {
            const pathArray = this.splitPath(getPath);
            const matches = keys.filter(key =>
              _.isEqual(key.slice(0, pathArray.length), pathArray),
            );
            return Promise.all(
              matches.map(match =>
                persist
                  .getItem(match)
                  .then(value => `${match.join('.')} = ${value}`),
              ),
            )
              .then(output => {
                process.stdout.write(output.join('\n') + '\n');
              })
              .catch(err => {
                process.stderr.write(err.message + '\n');
              });
          }),
        ).then(() => null);
      })
      .catch(err => {
        process.stderr.write(err.message + '\n');
      })
      .finally(() => {
        persist.close();
      });
  }

  /**
   * Handles the setting of key-value pairs in a persistent database.
   *
   * @param {ISetItem[]} setParameters - An array of items containing the key-value pairs to be set.
   * @param {string} dbpath - The path to the database where the items should be updated or added.
   * @return {Bluebird<void | Awaited<void>[]>} A promise that resolves when the operation is complete, either successfully or with errors logged.
   */
  private handleSet(
    setParameters: ISetItem[],
    dbpath: string,
  ): Bluebird<void | Awaited<void>[]> {
    let persist: LevelPersist;

    return LevelPersist.create(dbpath)
      .then(persistIn => {
        persist = persistIn;

        return Promise.all(
          setParameters.map(async (setParameter: ISetItem) => {
            const pathArray = this.splitPath(setParameter.key);

            try {
              let oldValue: any;
              try {
                oldValue = await persist.getItem(pathArray);
              } catch {
                oldValue = undefined;
              }
              const newValue =
                setParameter.value.length === 0
                  ? undefined
                  : oldValue === undefined || typeof oldValue === 'object'
                  ? JSON.parse(setParameter.value)
                  : oldValue.constructor(setParameter.value);
              await persist.setItem(pathArray, newValue);
              process.stdout.write('changed\n');
            } catch (err) {
              process.stderr.write(err.message + '\n');
            }
          }),
        ).then(() => null);
      })
      .catch(err => {
        process.stderr.write(err.message + '\n');
      })
      .finally(async () => {
        await persist.close();
      });
  }

  private handleDel(delPaths: string[], dbpath: string): BPromise<void> {
    let persist: LevelPersist;

    return LevelPersist.create(dbpath)
      .then(persistIn => {
        persist = persistIn;
        return persist.getAllKeys();
      })
      .then(keys => {
        return Promise.all(
          delPaths.map(delPath => {
            const pathArray = this.splitPath(delPath);
            const matches = keys.filter(key =>
              _.isEqual(key.slice(0, pathArray.length), pathArray),
            );
            return Promise.all(
              matches.map(match =>
                persist
                  .removeItem(match)
                  .then(() =>
                    process.stdout.write(`removed ${match.join('.')}\n`),
                  )
                  .catch(err => {
                    process.stderr.write(err.message + '\n');
                  }),
              ),
            );
          }),
        ).then(() => null);
      })
      .catch(err => {
        process.stderr.write(err.message + '\n');
      })
      .finally(() => {
        persist.close();
      });
  }

  private createTray(): Promise<void> {
    const trayIcon = require('./TrayIcon').default;
    this.trayIcons = new trayIcon(this.mExtensions.getApi());
    return Promise.resolve();
  }

  private connectTrayAndWindow() {
    if (this.trayIcons.initialized) {
      this.mainWindowReference.deref().connectToTray(this.trayIcons);
    }
  }

  /**
   * Generates the path to be used for multi-user mode configuration.
   * On Windows, it ensures the directory for shared application data exists under the "C:\ProgramData\vortex" path.
   * On other platforms, it logs an error message indicating multi-user mode is not supported and defaults to returning the user-specific data path.
   *
   * @return {string} The file path to be used for multi-user mode. On Windows, it returns the shared application data path.
   *                  On non-Windows platforms, it returns the application's user data path.
   */
  private multiUserPath() {
    if (process.platform === 'win32') {
      const vortexDataPath = path.join(process.env.ProgramData, 'vortex');
      try {
        fs.ensureDirSync(vortexDataPath);
      } catch (error) {
        // Not sure why this would happen, ensureDir isn't supposed to report a problem if
        // the directory exists, but there was a single report of EEXIST in this place.
        // Probably a bug related to the filesystem used in C:\ProgramData, we had similar
        // problems with OneDrive paths.
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
      return vortexDataPath;
    } else {
      log('error', 'Multi-User mode not implemented outside Windows');
      return app.getPath('userData');
    }
  }

  private createStore(
    restoreBackup?: string,
    mergeBackup?: string,
    repair?: boolean,
  ): BPromise<void> {
    const newStore = createVortexStore(this.sanityCheckCB);
    const backupPath = path.join(app.getPath('temp'), STATE_BACKUP_PATH);
    let backups: string[];

    const updateBackups = () =>
      fs
        .ensureDirAsync(backupPath)
        .then(() => fs.readdirAsync(backupPath))
        .filter(
          (fileName: string) =>
            fileName.startsWith('backup') && path.extname(fileName) === '.json',
        )
        .then(backupsIn => {
          backups = backupsIn;
        })
        .catch(err => {
          log('error', 'failed to read backups', err.message);
          backups = [];
        });

    const deleteBackups = () =>
      BPromise.map(backups, backupName =>
        fs
          .removeAsync(path.join(backupPath, backupName))
          .catch(() => undefined),
      ).then(() => null);

    // storing the last version that ran in the startup.json settings file.
    // We have that same information in the leveldb store but what if we need
    // to react to an upgrade before the state is loaded?
    // In development of 1.4 I assumed we had a case where this was necessary.
    // Turned out it wasn't, still feel it's sensible to have this
    // information available asap
    startupSettings.storeVersion = getApplication().version;

    // 1. load only user settings to determine if we're in multi-user mode
    // 2. load app settings to determine which extensions to load
    // 3. load extensions, then load all settings, including extensions
    return LevelPersist.create(
      path.join(this.appBasePath, currentStatePath),
      undefined,
      repair ?? false,
    )
      .then(levelPersistor => {
        this.levelPersistors.push(levelPersistor);
        return insertPersistor(
          'user',
          new SubPersistor(levelPersistor, 'user'),
        );
      })
      .catch(DataInvalid, err => {
        const failedPersistor = this.levelPersistors.pop();
        return failedPersistor.close().then(() => Promise.reject(err));
      })
      .then(() => {
        let dataPath = app.getPath('userData');
        const { multiUser } = newStore.getState().user;
        if (this.applicationArguments.userData !== undefined) {
          dataPath = this.applicationArguments.userData;
        } else if (multiUser) {
          dataPath = this.multiUserPath();
        }
        setVortexPath('userData', dataPath);
        this.appBasePath = dataPath;
        let created = false;
        try {
          fs.statSync(dataPath);
        } catch (err) {
          fs.ensureDirSync(dataPath);
          created = true;
        }
        if (multiUser && created) {
          permissions.allow(dataPath, 'group', 'rwx');
        }
        fs.ensureDirSync(path.join(dataPath, 'temp'));

        log('info', `using ${dataPath} as the storage directory`);
        if (multiUser || this.applicationArguments.userData !== undefined) {
          log(
            'info',
            'all further logging will happen in',
            path.join(dataPath, 'vortex.log'),
          );
          setLogPath(dataPath);
          log('info', '--------------------------');
          log('info', 'Vortex Version', getApplication().version);
          return LevelPersist.create(
            path.join(dataPath, currentStatePath),
            undefined,
            repair ?? false,
          ).then(levelPersistor => {
            this.levelPersistors.push(levelPersistor);
          });
        } else {
          return Promise.resolve();
        }
      })
      .then(() => {
        log('debug', 'reading app state');
        return insertPersistor(
          'app',
          new SubPersistor(last(this.levelPersistors), 'app'),
        );
      })
      .then(() => {
        if (newStore.getState().app.instanceId === undefined) {
          this.mFirstStart = true;
          const newId = uuid.v4();
          log('debug', 'first startup, generated instance id', {
            instanceId: newId,
          });
          newStore.dispatch(setInstanceId(newId));
        } else {
          log('debug', 'startup instance', {
            instanceId: newStore.getState().app.instanceId,
          });
        }
        const ExtensionManager = require('../util/ExtensionManager').default;
        this.mExtensions = new ExtensionManager(newStore);
        if (this.mExtensions.hasOutdatedExtensions) {
          log('debug', 'relaunching to remove outdated extensions');
          finalizeStoreWrite().then(() => relaunch());

          // relaunching the process happens asynchronously but we don't want to any further work
          // before that
          return new Promise(() => null);
        }
        const reducer = require('../reducers/index').default;
        newStore.replaceReducer(
          reducer(this.mExtensions.getReducers(), querySanitize),
        );
        return BPromise.mapSeries(allHives(this.mExtensions), hive =>
          insertPersistor(
            hive,
            new SubPersistor(last(this.levelPersistors), hive),
          ),
        );
      })
      .then(() => {
        log('debug', 'checking if state db needs to be upgraded');
        return importState(this.appBasePath);
      })
      .then(oldState => {
        // mark as imported first, otherwise we risk importing again, overwriting data.
        // this way we risk not importing but since the old state is still there, that
        // can be repaired
        return oldState !== undefined
          ? markImported(this.appBasePath).then(() => {
              newStore.dispatch({
                type: '__hydrate',
                payload: oldState,
              });
            })
          : Promise.resolve();
      })
      .then(() => {
        log('debug', 'updating state backups');
        return updateBackups();
      })
      .then(() => {
        if (restoreBackup !== undefined) {
          log('info', 'restoring state backup', restoreBackup);
          return fs
            .readFileAsync(restoreBackup, { encoding: 'utf-8' })
            .then(backupState => {
              newStore.dispatch({
                type: '__hydrate_replace',
                payload: JSON.parse(backupState),
              });
            })
            .then(() => deleteBackups())
            .then(() => updateBackups())
            .catch(err => {
              if (err instanceof UserCanceled) {
                return Promise.reject(err);
              }
              terminate(
                {
                  message: 'Failed to restore backup',
                  details:
                    err.code !== 'ENOENT'
                      ? err.message
                      : "Specified backup file doesn't exist",
                  path: restoreBackup,
                },
                {},
                false,
              );
            });
        } else if (mergeBackup !== undefined) {
          log('info', 'merging state backup', mergeBackup);
          return fs
            .readFileAsync(mergeBackup, { encoding: 'utf-8' })
            .then(backupState => {
              newStore.dispatch({
                type: '__hydrate',
                payload: JSON.parse(backupState),
              });
            })
            .catch(err => {
              if (err instanceof UserCanceled) {
                return Promise.reject(err);
              }
              terminate(
                {
                  message: 'Failed to merge backup',
                  details:
                    err.code !== 'ENOENT'
                      ? err.message
                      : "Specified backup file doesn't exist",
                  path: mergeBackup,
                },
                {},
                false,
              );
            });
        } else {
          return Promise.resolve();
        }
      })
      .then(() => {
        const hydrateHandler = (stepIn: IPresetStep): Promise<void> => {
          newStore.dispatch({
            type: '__hydrate',
            payload: (stepIn as IPresetStepHydrateState).state,
          });

          return Promise.resolve();
        };
        presetManager.on('hydrate', hydrateHandler);
        presetManager.now('hydrate', hydrateHandler);
      })
      .then(() => {
        this.thunkStore = newStore;

        let sendState: Buffer;

        (global as any).getReduxStateMsgpack = (idx: number) => {
          const msgpack: typeof msgpackT = require('@msgpack/msgpack');
          if (sendState === undefined || idx === 0) {
            sendState = Buffer.from(
              msgpack.encode(
                replaceRecursive(
                  this.thunkStore.getState(),
                  undefined,
                  '__UNDEFINED__',
                ),
              ),
            );
          }
          const res = sendState.slice(
            idx * STATE_CHUNK_SIZE,
            (idx + 1) * STATE_CHUNK_SIZE,
          );
          return res.toString('base64');
        };

        this.mExtensions.setStore(newStore);
        log('debug', 'setting up extended store');
        return extendStore(newStore, this.mExtensions);
      })
      .then(() => {
        if (backups.length > 0) {
          const sorted = backups.sort((lhs, rhs) => rhs.localeCompare(lhs));
          const mostRecent = sorted[0];
          const timestamp = path
            .basename(mostRecent, '.json')
            .replace('backup_', '');
          const date = new Date(+timestamp);
          const dateString =
            `${date.toDateString()} ` +
            `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
          const replace = { date: dateString };
          this.thunkStore.dispatch(
            addNotification({
              type: 'info',
              message:
                'Found an application state backup. Created on: {{date}}',
              actions: [
                {
                  title: 'Restore',
                  action: async () => {
                    await this.thunkStore.dispatch(
                      showDialog(
                        'question',
                        'Restoring Application State',
                        {
                          bbcode:
                            'You are attempting to restore an application state backup which will revert any ' +
                            'state changes you have made since the backup was created.[br][/br][br][/br]' +
                            'Please note that this operation will NOT uninstall/remove any mods you ' +
                            'may have downloaded/installed since the backup was created, however Vortex ' +
                            'may "forget" some changes:[list]' +
                            '[*] Which download archive belongs to which mod installation, exhibiting ' +
                            'itself as "duplicate" entries of the same mod (archive entry and installed mod entry).' +
                            '[*] The state of an installed mod - reverting it to a disabled state.' +
                            '[*] Any conflict rules you had defined after the state backup.' +
                            '[*] Any other configuration changes you may have made.' +
                            '[/list][br][/br]' +
                            'Are you sure you wish to restore the backed up state ?',
                        },
                        [
                          { label: 'Cancel' },
                          {
                            label: 'Restore',
                            action: () => {
                              log('info', 'sorted backups', sorted);
                              spawnSelf([
                                '--restore',
                                path.join(backupPath, mostRecent),
                              ]);
                              app.exit();
                            },
                          },
                        ],
                      ),
                    );
                  },
                },
                {
                  title: 'Delete',
                  action: async dismiss => {
                    await deleteBackups();
                    dismiss();
                  },
                },
              ],
              replace,
            }),
          );
        } else if (!repair) {
          // we started without any problems, save this application state
          return createFullStateBackup('startup', this.thunkStore)
            .then(() => Promise.resolve())
            .catch(err =>
              log(
                'error',
                'Failed to create startup state backup',
                err.message,
              ),
            );
        }
        return Promise.resolve();
      })
      .then(() => this.mExtensions.doOnce());
  }

  private sanityCheckCB = (err: StateError) => {
    err['attachLogOnReport'] = true;
    showError(
      this.thunkStore.dispatch,
      'An invalid state change was prevented, this was probably caused by a bug',
      err,
    );
  };

  private initDevel(): BPromise<void> {
    if (process.env.NODE_ENV === 'development') {
      const { installDevelExtensions } =
        require('../util/devel') as typeof develT;
      return installDevelExtensions();
    } else {
      return BPromise.resolve();
    }
  }

  showMainWindow(startMinimized: boolean) {
    if (this.mainWindowReference === null) {
      // ??? renderer has signaled it's done loading before we even started it?
      // that can't be right...
      app.exit();
      return;
    }
    const windowMetrics = this.thunkStore.getState().settings.window;
    const maximized: boolean = windowMetrics.maximized || false;
    try {
      this.mainWindowReference.deref().show(maximized, startMinimized);
    } catch (err) {
      if (this.mainWindowReference === null) {
        // It's possible for the user to forcefully close Vortex just
        //  as it attempts to show the main window and obviously cause
        //  the app to crash if we don't handle the exception.
        log('error', 'failed to show main window', err);
        app.exit();
        return;
      } else {
        throw err;
      }
    }
    setWindow(this.mainWindowReference.deref().getHandle());
  }

  private testUserEnvironment(): Promise<void> {
    // Should be used to test the user's environment for known
    //  issues before starting up Vortex.
    // On Windows:
    //  - Ensure we're able to retrieve the user's documents folder.
    if (process.platform === 'win32') {
      try {
        const documentsFolder = app.getPath('documents');
        return documentsFolder !== ''
          ? Promise.resolve()
          : Promise.reject(new DocumentsPathMissing());
      } catch (err) {
        return Promise.reject(new DocumentsPathMissing());
      }
    } else {
      // No tests needed.
      return Promise.resolve();
    }
  }

  private async validateFiles(): Promise<void> {
    const VALIDATION_ERROR_MESSAGE =
      'Your Vortex installation has been corrupted. ' +
      'This could be the result of a virus or manual manipulation. ' +
      'Vortex might still appear to work (partially) but we suggest ' +
      "you reinstall it. For more information please refer to Vortex's log files.";

    const validation = await validateFiles(getVortexPath('assets_unpacked'));

    if (validation.changed.length > 0 || validation.missing.length > 0) {
      log('info', 'Files were manipulated', validation);
      await this.handleValidationDialog(VALIDATION_ERROR_MESSAGE);
    }
  }

  private async handleValidationDialog(errorMessage: string): Promise<void> {
    const dialogResult = await dialog.showMessageBox(null, {
      type: 'error',
      title: 'Installation corrupted',
      message: errorMessage,
      noLink: true,
      buttons: ['Quit', 'Ignore'],
    });

    if (dialogResult.response === 0) {
      app.quit();
    } else {
      disableErrorReport();
    }
  }

  /**
   * Applies the provided arguments to control the application's behavior, such as downloading or installing a resource or handling startup actions.
   *
   * @param {IParameters} args - Arguments that may include download, install, or startup options.
   * @return {void}
   */
  private applyArguments(args: IParameters): void {
    const initializeDelay =
      this.mainWindowReference === undefined
        ? BPromise.delay(2000) // Wait for the application to fully initialize
        : BPromise.resolve(undefined);

    // Handle download/install arguments
    if (args.download || args.install) {
      initializeDelay.then(() => {
        if (!this.mainWindowReference) {
          this.showUnresponsiveDialog();
          return;
        }
        this.handleExternalURL(args.download || args.install!, !!args.install);
      });
      return;
    }

    // Handle startup without download/install arguments
    if (this.mainWindowReference) {
      this.showMainWindow(!!args.startMinimized);
    }
  }

  /**
   * Sends the external URL to the main application window.
   *
   * @param {string} url - The URL to be sent.
   * @param {boolean} isInstall - Whether this is an install request.
   */
  private handleExternalURL(url: string, isInstall: boolean): void {
    const mainWindowReference = this.mainWindowReference!.deref();
    mainWindowReference.sendExternalURL(url, isInstall);
  }

  /**
   * Displays an error dialog to notify the user that the UI is unresponsive.
   */
  private showUnresponsiveDialog(): void {
    dialog.showErrorBox(
      'Vortex Unresponsive',
      'Vortex appears to be frozen. Please close Vortex and try again.',
    );
  }
}

export default Application;
