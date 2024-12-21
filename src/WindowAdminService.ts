import Promise from 'bluebird';
import { log } from './util/log';
import winapi from 'winapi-bindings';
import path from 'path';
import { Result } from './models/result';
import { IParameters } from './util/commandLine';
import { app } from 'electron';

export class WindowAdminService {





  /**
   * Checks if User Account Control (UAC) is enabled on the system.
   * On Windows platforms, it retrieves specific registry values related to system policies to determine the UAC status.
   * In non-Windows environments, it always resolves as enabled.
   *
   * @return {Promise<boolean>} A promise that resolves to `true` if UAC is enabled, or `false` if it is disabled.
   *                            Returns `true` if the registry keys cannot be retrieved or in non-Windows environments.
   */
  static isUACEnabled(): Promise<boolean> {

    if (process.platform !== 'win32') {
      return Promise.resolve(true);
    }

    // Define constants for the registry path and keys
    const SYSTEM_POLICY_REG_PATH = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';

    const SystemPolicyKeys = {
      CONSENT_PROMPT_ADMIN: 'ConsentPromptBehaviorAdmin',
      CONSENT_PROMPT_USER: 'ConsentPromptBehaviorUser',
    };

    const getSystemPolicyValue = (policyKey: string) => {
      try {
        const registryValue = winapi.RegGetValue('HKEY_LOCAL_MACHINE', SYSTEM_POLICY_REG_PATH, policyKey);
        return Promise.resolve({
          policyKey,
          valueType: registryValue.type,
          valueData: registryValue.value,
        });
      } catch (error) {
        // Log the failure and resolve with undefined, as the registry key might not exist in this version of Windows
        log('debug', 'Failed to retrieve UAC policy value', error);
        return Promise.resolve(undefined);
      }
    };

    return (
      Promise.all([
        getSystemPolicyValue('ConsentPromptBehaviorAdmin'),
        getSystemPolicyValue('ConsentPromptBehaviorUser'),
      ])
        .then(res => {
          res.forEach(value => {
            if (value !== undefined) {
              log(
                'debug',
                'UAC settings found',
                `${value.key}: ${value.value}`,
              );
            }
          });
          const adminConsent = res[0];
          return adminConsent.type === 'REG_DWORD' && adminConsent.value === 0
            ? Promise.resolve(false)
            : Promise.resolve(true);
        })
        // Perfectly ok not to have the registry keys.
        .catch(err => Promise.resolve(true))
    );
  }






  /**
   * Attempts to determine the user data path based on the provided parameters.
   *
   * @param {IParameters} args - The parameters containing user data and shared flag.
   * @param {string} vortexPath - The vortex path to resolve user data location.
   * @return {Result<string>} An object containing a status indicating success or failure, and either the resolved user data path or an error.
   */
  public static tryFindUserData(
    args: IParameters,
    vortexPath: string,
  ): Result<string> {
    try {
      // if userData specified, use it
      let userData =
        args.userData ??
        // (only on windows) use ProgramData from environment
        (args.shared && process.platform === 'win32'
          ? path.join(process.env.ProgramData, 'vortex')
          : // this allows the development build to access data from the
            // production version and vice versa
            path.resolve(app.getPath('userData'), '..', vortexPath));

      return { ok: true, value: userData };
    } catch (err: Error | any) {
      return { ok: false, error: err };
    }
  }
}
