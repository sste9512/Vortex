/**
 * wrapper for the fs / fs-extra-promise module
 * this allows us to customise the behaviour of fs function across the application.
 * The api should remain compatible with fs-extra-promise, but extensions can be made
 * Notable behaviour changes:
 * - common async functions now retrieve a backtrace before calling, so that on error
 *   they can provide a useful backtrace to where the function was called
 *   (for many error cases the original function didn't have a stack trace in the first place)
 * - retrying on functions that commonly fail temporarily due to external applications
 *   (virus scanners, functions called from vortex) locking files.
 * - ignoring ENOENT error when deleting a file.
 */

import { UserCanceled } from './CustomErrors';
import { delayed } from './delayed';

import * as PromiseBB from 'bluebird';
import { dialog as dialogIn, remote } from 'electron';
import * as fs from 'fs-extra-promise';
import * as I18next from 'i18next';
import * as ipc from 'node-ipc';
import * as path from 'path';
import { allow as allowT, getUserId } from 'permissions';
import * as rimraf from 'rimraf';
import { generate as shortid } from 'shortid';
import { runElevated, Win32Error } from 'vortex-run';

const dialog = remote !== undefined ? remote.dialog : dialogIn;

export { constants, FSWatcher, Stats, WriteStream } from 'fs';

// simple re-export of functions we don't touch (yet)
export {
  accessSync,
  closeSync,
  createReadStream,
  createWriteStream,
  linkSync,
  openSync,
  readFileSync,
  readJSONSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from 'fs-extra-promise';

const NUM_RETRIES = 3;
const RETRY_DELAY_MS = 100;
const RETRY_ERRORS = new Set(['EPERM', 'EBUSY', 'EUNKNOWN']);

function unlockConfirm(filePath: string): PromiseBB<boolean> {
  if (dialog === undefined) {
    return PromiseBB.resolve(false);
  }

  const options: Electron.MessageBoxOptions = {
    title: 'Access denied',
    message: `Vortex needs to access "${filePath}" but doesn\'t have permission to.\n`
      + 'If your account has admin rights Vortex can unlock the file for you. '
      + 'Windows will show an UAC dialog.',
    buttons: [
      'Cancel',
      'Retry',
      'Give permission',
    ],
    type: 'warning',
    noLink: true,
  };

  const choice = dialog.showMessageBox(
    remote !== undefined ? remote.getCurrentWindow() : null,
    options);
  return (choice === 0)
    ? PromiseBB.reject(new UserCanceled())
    : PromiseBB.resolve(choice === 2);

}

function busyRetry(filePath: string): PromiseBB<boolean> {
  if (dialog === undefined) {
    return PromiseBB.resolve(false);
  }

  const options: Electron.MessageBoxOptions = {
      title: 'File busy',
      message: `Vortex needs to access "${filePath}" but it\'s open in another application. `
             + 'Please close the file in all other applications and then retry',
      buttons: [
        'Cancel',
        'Retry',
      ],
      type: 'warning',
      noLink: true,
    };

  const choice = dialog.showMessageBox(
    remote !== undefined ? remote.getCurrentWindow() : null,
    options);
  return (choice === 0)
    ? PromiseBB.reject(new UserCanceled())
    : PromiseBB.resolve(true);
}

function errorRepeat(code: string, filePath: string): PromiseBB<boolean> {
  if (code === 'EBUSY') {
    return busyRetry(filePath);
  } else if (code === 'EPERM') {
    return unlockConfirm(filePath)
      .then(doUnlock => {
        if (doUnlock) {
          const userId = getUserId();
          return elevated((ipcPath, req: NodeRequireFunction) => {
            const { allow }: { allow: typeof allowT } = req('permissions');
            return allow(filePath, userId as any, 'rwx');
          }, { filePath, userId })
            .then(() => true);
        } else {
          return PromiseBB.resolve(true);
        }
      });
  } else {
    return PromiseBB.resolve(false);
  }
}

function restackErr(error: Error, stackErr: Error): Error {
  error.stack = error.message + '\n' + stackErr.stack;
  return error;
}

function errorHandler(error: NodeJS.ErrnoException, stackErr: Error): PromiseBB<void> {
  return errorRepeat(error.code, (error as any).dest || error.path)
    .then(repeat => repeat
      ? PromiseBB.resolve()
      : PromiseBB.reject(restackErr(error, stackErr)))
    .catch(err => PromiseBB.reject(restackErr(err, stackErr)));
}

function genWrapperAsync<T extends (...args) => any>(func: T): T {
  const wrapper = (stackErr: Error, ...args) => 
    func(...args)
      .catch(err => errorHandler(err, stackErr)
        .then(() => wrapper(stackErr, ...args)));

  const res = (...args) => wrapper(new Error(), ...args);
  return res as T;
}

const chmodAsync = genWrapperAsync(fs.chmodAsync);
const closeAsync = genWrapperAsync(fs.closeAsync);
const fsyncAsync = genWrapperAsync(fs.fsyncAsync);
const linkAsync = genWrapperAsync(fs.linkAsync);
const lstatAsync = genWrapperAsync(fs.lstatAsync);
const mkdirAsync = genWrapperAsync(fs.mkdirAsync);
const moveAsync = genWrapperAsync(fs.moveAsync);
const openAsync = genWrapperAsync(fs.openAsync);
const readdirAsync = genWrapperAsync(fs.readdirAsync);
const readFileAsync = genWrapperAsync(fs.readFileAsync);
const readlinkAsync = genWrapperAsync(fs.readlinkAsync);
const statAsync = genWrapperAsync(fs.statAsync);
const symlinkAsync = genWrapperAsync(fs.symlinkAsync);
const utimesAsync = genWrapperAsync(fs.utimesAsync);
const writeAsync = genWrapperAsync(fs.writeAsync);
const writeFileAsync = genWrapperAsync(fs.writeFileAsync);

export {
  chmodAsync,
  closeAsync,
  fsyncAsync,
  linkAsync,
  lstatAsync,
  mkdirAsync,
  moveAsync,
  openAsync,
  readlinkAsync,
  readdirAsync,
  readFileAsync,
  statAsync,
  symlinkAsync,
  utimesAsync,
  writeAsync,
  writeFileAsync,
};

export function ensureDirSync(dirPath: string) {
  try {
    fs.ensureDirSync(dirPath);
  } catch (err) {
    throw restackErr(err, new Error());
  }
}

export function ensureFileAsync(filePath: string): PromiseBB<void> {
  return (fs as any).ensureFileAsync(filePath);
}

export function ensureDirAsync(dirPath: string): PromiseBB<void> {
  const stackErr = new Error();
  return fs.ensureDirAsync(dirPath)
    .catch(err => {
      // ensureDir isn't supposed to cause EEXIST errors as far as I understood
      // it but on windows, when targeting a OneDrive path (and similar?)
      // it apparently still does
      if (err.code === 'EEXIST') {
        return PromiseBB.resolve();
      }
      return PromiseBB.reject(restackErr(err, stackErr));
    });
}

function selfCopyCheck(src: string, dest: string) {
  return PromiseBB.join(fs.statAsync(src), fs.statAsync(dest)
                .catch(err => err.code === 'ENOENT' ? PromiseBB.resolve({}) : PromiseBB.reject(err)))
    .then((stats: fs.Stats[]) => (stats[0].ino === stats[1].ino)
        ? PromiseBB.reject(new Error(
          `Source "${src}" and destination "${dest}" are the same file (id "${stats[0].ino}").`))
        : PromiseBB.resolve());
}

/**
 * copy file
 * The copy function from fs-extra doesn't (at the time of writing) correctly check that a file isn't
 * copied onto itself (it fails for links or potentially on case insensitive disks), so this makes
 * a check based on the ino number.
 * Unfortunately a bug in node.js (https://github.com/nodejs/node/issues/12115) prevents this check from
 * working reliably so it can currently be disabled.
 * @param src file to copy
 * @param dest destination path
 * @param options copy options (see documentation for fs)
 */
export function copyAsync(src: string, dest: string,
                          options?: fs.CopyOptions & { noSelfCopy?: boolean }): PromiseBB<void> {
  const stackErr = new Error();
  // fs.copy in fs-extra has a bug where it doesn't correctly avoid copying files onto themselves
  const check = (options !== undefined) && options.noSelfCopy
    ? PromiseBB.resolve()
    : selfCopyCheck(src, dest);
  return check
    .then(() => copyInt(src, dest, options || undefined, stackErr))
    .catch(err => PromiseBB.reject(restackErr(err, stackErr)));
}

function copyInt(
    src: string, dest: string,
    options: fs.CopyOptions,
    stackErr: Error) {
  return fs.copyAsync(src, dest, options)
    .catch((err: NodeJS.ErrnoException) =>
      errorHandler(err, stackErr).then(() => copyInt(src, dest, options, stackErr)));
}

export function removeSync(dirPath: string) {
  rimraf.sync(dirPath, { maxBusyTries: 10 });
}

export function removeAsync(dirPath: string): PromiseBB<void> {
  return removeInt(dirPath, new Error());
}

function removeInt(dirPath: string, stackErr: Error): PromiseBB<void> {
  return new PromiseBB<void>((resolve, reject) => {
    rimraf(dirPath, { maxBusyTries: 10 }, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    })
  })
    .catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT')
      // don't mind if a file we wanted deleted was already gone
      ? PromiseBB.resolve()
      : errorHandler(err, stackErr)
        .then(() => removeInt(dirPath, stackErr)));
}

export function unlinkAsync(dirPath: string): PromiseBB<void> {
  return unlinkInt(dirPath, new Error());
}

function unlinkInt(dirPath: string, stackErr: Error): PromiseBB<void> {
  return fs.unlinkAsync(dirPath)
    .catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT')
        // don't mind if a file we wanted deleted was already gone
        ? PromiseBB.resolve()
        : errorHandler(err, stackErr)
          .then(() => unlinkInt(dirPath, stackErr)));
}

export function renameAsync(sourcePath: string, destinationPath: string): PromiseBB<void> {
  return renameInt(sourcePath, destinationPath, new Error());
}

function renameInt(sourcePath: string, destinationPath: string, stackErr: Error): PromiseBB<void> {
  return fs.renameAsync(sourcePath, destinationPath)
    .catch((err: NodeJS.ErrnoException) => (err.code === 'EPERM')
      ? fs.statAsync(destinationPath)
        .then(stat => stat.isDirectory()
          ? PromiseBB.reject(restackErr(err, stackErr))
          : errorHandler(err, stackErr)
            .then(() => renameInt(sourcePath, destinationPath, stackErr)))
        .catch(newErr => PromiseBB.reject(restackErr(newErr, stackErr)))
      : errorHandler(err, stackErr)
        .then(() => renameInt(sourcePath, destinationPath, stackErr)));
}

export function rmdirAsync(dirPath: string): PromiseBB<void> {
  return rmdirInt(dirPath, new Error(), NUM_RETRIES);
}

function rmdirInt(dirPath: string, stackErr: Error, tries: number): PromiseBB<void> {
  return fs.rmdirAsync(dirPath)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        // don't mind if a file we wanted deleted was already gone
        return PromiseBB.resolve();
      } else if (RETRY_ERRORS.has(err.code) && (tries > 0)) {
          return delayed(RETRY_DELAY_MS)
            .then(() => rmdirInt(dirPath, stackErr, tries - 1));
      }
      throw restackErr(err, stackErr);
    });
}

function elevated(func: (ipc, req: NodeRequireFunction) => Promise<void>,
                  parameters: any): PromiseBB<void> {
  return new PromiseBB<void>((resolve, reject) => {
    const ipcInst = new ipc.IPC();
    const id = shortid();
    let resolved = false;
    ipcInst.serve(`__fs_elevated_${id}`, () => {
      runElevated(`__fs_elevated_${id}`, func, parameters)
        .catch(Win32Error, err => {
          if (err.code === 5) {
            // this code is returned when the user rejected the UAC dialog. Not currently
            // aware of another case
            reject(new UserCanceled());
          } else {
            reject(new Error(`OS error ${err.message} (${err.code})`));
          }
        })
        .catch(err => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
    });
    ipcInst.server.on('socket.disconnected', () => {
      ipcInst.server.stop();
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
    ipcInst.server.on('error', ipcErr => {
      if (!resolved) {
        resolved = true;
        reject(new Error(ipcErr));
      }
    });
    ipcInst.server.on('disconnect', () => {
      ipcInst.server.stop();
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
    ipcInst.server.start();
  });
}

export function ensureDirWritableAsync(dirPath: string,
                                       confirm: () => PromiseBB<void>): PromiseBB<void> {
  return fs.ensureDirAsync(dirPath)
    .then(() => {
      const canary = path.join(dirPath, '__vortex_canary');
      return (fs as any).ensureFileAsync(canary)
                    .then(() => fs.removeAsync(canary));
    })
    .catch(err => {
      if (err.code === 'EPERM') {
        return confirm()
          .then(() => {
            const userId = getUserId();
            return elevated((ipcPath, req: NodeRequireFunction) => {
              // tslint:disable-next-line:no-shadowed-variable
              const fs = req('fs-extra-promise');
              const { allow } = req('permissions');
              return fs.ensureDirAsync(dirPath)
                .then(() => allow(dirPath, userId, 'rwx'));
            }, { dirPath, userId });
          });
      } else {
        return PromiseBB.reject(err);
      }
    });
}

export function forcePerm<T>(t: I18next.TranslationFunction, op: () => PromiseBB<T>): PromiseBB<T> {
  return op()
    .catch(err => {
      if (err.code === 'EPERM') {
        const choice = dialog.showMessageBox(
          remote !== undefined ? remote.getCurrentWindow() : null, {
          title: 'Access denied',
          message: t('Vortex needs to access "{{ fileName }}" but doesn\'t have permission to.\n'
                   + 'If your account has admin rights Vortex can unlock the file for you. '
                   + 'Windows will show an UAC dialog.',
            { replace: { fileName: err.path } }),
          buttons: [
            'Cancel',
            'Rety',
            'Give permission',
          ],
          noLink: true,
          type: 'warning',
          detail: err.path,
        });
        if (choice === 1) { // Retry
          return forcePerm(t, op);
        } else if (choice === 2) { // Give Permission
          let filePath = err.path;
          const userId = getUserId();
          return fs.statAsync(err.path)
            .catch((statErr) => {
              if (statErr.code === 'ENOENT') {
                filePath = path.dirname(filePath);
              }
              return PromiseBB.resolve();
            })
            .then(() => elevated((ipcPath, req: NodeRequireFunction) => {
                // tslint:disable-next-line:no-shadowed-variable
                const { allow } = req('permissions');
                return allow(filePath, userId, 'rwx');
              }, { filePath, userId }))
            .then(() => forcePerm(t, op));
        } else {
          return PromiseBB.reject(new UserCanceled());
        }
      } else {
        return PromiseBB.reject(err);
      }
    });
}
