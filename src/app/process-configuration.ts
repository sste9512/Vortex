import os from 'os';

export class ProcessConfiguration {
  
  public uvThreadPoolSize: number;
  public maxMemorySize : number;

  public crashReportingDiscriminator: string;
  public nodeEnvironmentDiscriminator: string;

  
  public static loadAndCompute(configurationPath: string) : Awaited<ProcessConfiguration>{
    const processConfiguration = new ProcessConfiguration();

    processConfiguration.uvThreadPoolSize = os.cpus().length * 1.5;
    processConfiguration.crashReportingDiscriminator = Math.random() > 0.5 ? 'vortex' : 'electron';
    return processConfiguration;
  }
}


export class PathConfiguration {

     public startupLogPath: string;
     public vortexAppPath: string;
     public tempVortexPath: string;
     public dumpPath: string;


     public loadAndCompute(configurationPath: string) : Awaited<PathConfiguration>{
        const pathConfiguration = new PathConfiguration();



        return pathConfiguration;
     }
}
