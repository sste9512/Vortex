import { app, ipcMain, screen, webContents } from 'electron';
import { WindowAdminService } from '../window-admin-service';
import { NodeLogging } from '../util/logfunctions';
import { path } from 'd3';
import { currentStatePath, finalizeStoreWrite } from '../util/store';
import commandLine from '../util/commandLine';
import { log } from 'vortex-api';
import Application from './Application';
import { injectable, singleton } from 'tsyringe';

@singleton()
export class ElectronApplicationBridge {

  private electronAppWeakReference: WeakRef<Electron.App>;
  private applicationWeakReference: WeakRef<Application>;

  constructor(private electronApp: Electron.App, private application: Application) {
    this.electronAppWeakReference = new WeakRef<Electron.App>(electronApp);
    this.applicationWeakReference = new WeakRef<Application>(application);
    this.bindAllEvents();
  }

  /**
   * Sets up and binds application-level event handlers to manage the app's lifecycle and behavior.
   *
   * @return {void} Does not return a value.
   */

  public bindAllEvents(): void {
    this.electronAppWeakReference
      .deref()
      .on('window-all-closed', this.onWindowsAllClosed);
    this.electronAppWeakReference.deref().on('activate', this.onActivate);
    this.electronAppWeakReference
      .deref()
      .on('second-instance', this.handleAppSecondInstance);
    this.electronAppWeakReference
      .deref()
      .whenReady()
      .then(this.onApplicationReady);
    this.electronAppWeakReference
      .deref()
      .on('web-contents-created', this.onWebContentsCreated);
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
    // if (this.trayIcons !== undefined) {
    //   this.trayIcons.close();
    // }
    // if (this.mDeinitCrashDump !== undefined) {
    //   this.mDeinitCrashDump();
    // }
    this.applicationWeakReference.deref().cleanup();
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
    // if (this.mainWindowReference !== undefined) {
    //   await this.mainWindowReference.deref().create(this.thunkStore);
    // }
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

  private handleAppSecondInstance(event: Event, secondaryArgv: string[]) {
    // log('debug', 'getting arguments from second instance', secondaryArgv);
    // this.applyArguments(commandLine(secondaryArgv, true));
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

    // let userResult = WindowAdminService.tryFindUserData(
    //   this.applicationArguments,
    //   vortexPath,
    // );
    //
    // let userData: string = '';
    //
    // if (userResult.ok) {
    //   NodeLogging.printSuccess('Using user data path: ' + userResult.value);
    //   userData = path.join(userResult.value, currentStatePath);
    // }
    // if (userResult.ok == false) {
    //   NodeLogging.printErrorAsGrid(userResult.error.message);
    // }
  }

  public dispose() {}
}
