import { app, dialog } from 'electron';

const ERROR_TITLE_DL_OPEN = 'Vortex failed to start up';
const ERROR_TITLE_UNHANDLED = 'Unhandled error';

const ERROR_MESSAGE_DL_OPEN = (message: string) => 
  `An unexpected error occurred while Vortex was initialising:\n\n${message}\n\n` +
  `This is often caused by a bad installation of the app, ` +
  `a security app interfering with Vortex ` +
  `or a problem with the Microsoft Visual C++ Redistributable installed on your PC. ` +
  `To solve this issue please try the following:\n\n` +
  `- Wait a moment and try starting Vortex again\n` +
  `- Reinstall Vortex from the Nexus Mods website\n` +
  `- Install the latest Microsoft Visual C++ Redistributable (find it using a search engine)\n` +
  `- Disable anti-virus or other security apps that might interfere and install Vortex again\n\n` +
  `If the issue persists, please create a thread in our support forum for further assistance.`;

const ERROR_MESSAGE_UNHANDLED = (stack: string) => 
  `Vortex failed to start up. This is usually caused by foreign software (e.g. Anti Virus) interfering.\n\n${stack}`;

export const handleStartupError = (error: Error): void => {
  if (error.stack.includes('[as dlopen]')) {
    dialog.showErrorBox(ERROR_TITLE_DL_OPEN, ERROR_MESSAGE_DL_OPEN(error.message));
  } else {
    dialog.showErrorBox(ERROR_TITLE_UNHANDLED, ERROR_MESSAGE_UNHANDLED(error.stack));
  }
  app.exit(1);
};