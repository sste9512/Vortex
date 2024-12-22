import Bluebird from 'bluebird';
import * as fs from './util/fs';
import path from 'path';
import getVortexPath from './util/getVortexPath';
import { setInstallType } from './actions';
import { ThunkStore } from './types/IExtensionContext';
import { IState } from 'vortex-api/lib/types/IState';



// TODO: Figure out whether this is node or renderer
export class InstallationService {
  /**
   * we are checking to see if an uninstaller exists as if it does, it means it was installed via our installer.
   * if it doesn't, then something else installed it. Maybe GOG, or EPIC, or something.
   *
   * TODO: we want to further check managed types to distiguish between anything that isn't us.
   * Quick research says we need to file pattern match the install directory to see what files gog or epic adds etc.
   * This should determine where it's from
   *
   * GOG
   *
   * Maybe the existance of: (the number being the gog product id)
   * 'goggame-galaxyFileList.ini'
   * 'goggame-2053394557.info'
   * 'goggame-2053394557.hashdb'
   *
   * EPIC
   *
   *
   */
  public static identifyInstallType(store: ThunkStore<IState>): Bluebird<void> {
    return fs
      .statAsync(
        path.join(getVortexPath('application'), 'Uninstall Vortex.exe'),
      )
      .then(() => {
        store.dispatch(setInstallType('regular'));
      })
      .catch(() => {
        store.dispatch(setInstallType('managed'));
      });
  }
}
