import chalk from 'chalk';

/**
 * Prints an error message as a grid.
 * @param {string} errorMsg - The error message to display.
 */
export function printErrorAsGrid(errorMsg) {
  const topBottomBorder = borderChar.repeat(gridWidth + 2);
  const paddedMessage = `${borderChar}${paddingChar.repeat(padding)}${chalk.red(
    errorMsg,
  )}${paddingChar.repeat(padding)}${borderChar}`; // Highlight error message in red

  const borderChar = '*';
  const paddingChar = ' ';
  const padding = 2;
  const messageLength = errorMsg.length;
  const gridWidth = messageLength + padding * 2;

  console.log(topBottomBorder);
  console.log(paddedMessage);
  console.log(topBottomBorder);
}




/**
 * Prints a success message highlighted in green.
 * @param {string} successMsg - The success message to display.
 */
export function printSuccess(successMsg) {
  console.log(chalk.green(successMsg)); // Highlight success message in green
}