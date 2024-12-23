import { container } from 'tsyringe';
import commandLine from '../util/commandLine';



const getVortexPath = (): string =>
  process.env.NODE_ENV === 'development' ? 'vortex_devel' : 'vortex';


export function initNodeContainer(mainArguments: string[]) {
     container.register('mainArguments', { useValue: mainArguments });
     container.registerInstance("parameters", commandLine(mainArguments, false));
     container.registerInstance("vortexPath", getVortexPath());
}