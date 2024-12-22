import BPromise from 'bluebird';

export interface IApplication {
  checkUpgrade(): BPromise<void>;

  showMainWindow(startMinimized: boolean): void;
}