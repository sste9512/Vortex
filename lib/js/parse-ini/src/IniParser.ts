import { IIniFormat } from './IIniFormat';
import IniFile from './IniFile';

import * as Promise from 'bluebird';

class IniParser {
  private mFormat: IIniFormat;
  constructor(format: IIniFormat) {
    this.mFormat = format;
  }

  public read<T>(filePath: string): Promise<IniFile<T>> {
    return this.mFormat.read(filePath)
    .then((data: T) => {
      return new IniFile(data);
    });
  }

  public write<T>(filePath: string, file: IniFile<T>): Promise<void> {
    console.log('write', filePath);
    return this.mFormat.write(filePath, file.data, file.changes())
        .then(() => file.apply());
  }
}

export default IniParser;
