import * as fileStream from 'fs';

export class FileService {


 public static readFile(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    return new Promise((resolve, reject) => {
      fileStream.readFile(path, encoding, (err, data) => {
        if (err) {
          return reject(err);
        }
        resolve(data);
      });
    });
  }

 public static writeFile(
    path: string,
    data: string | NodeJS.ArrayBufferView,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      fileStream.writeFile(path, data, err => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

 public static appendFile(path: string, data: string | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      fileStream.appendFile(path, data, err => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

 public static deleteFile(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      fileStream.unlink(path, err => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

 public static fileExists(path: string): Promise<boolean> {
    return new Promise(resolve => {
      fileStream.access(path, fileStream.constants.F_OK, err => {
        resolve(!err);
      });
    });
  }
}
