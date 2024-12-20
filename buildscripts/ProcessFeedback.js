/**
 * The ProcessFeedback class is a utility for handling process output and errors,
 * providing structured logging and a method to finalize process reporting with a status code.
 */
export class ProcessFeedback {
  constructor(id) {
    this.id = id;
    this.output = [];
  }

  /**
   * Completes the execution of a process and logs the appropriate output and status message.
   *
   * @param {string} desc - A brief description of the process being finished.
   * @param {number} code - The exit code indicating the success or failure of the process. Non-zero indicates failure.
   * @return {void} This method does not return any value.
   */
  finish(desc, code) {
    if (code !== 0) {
      this.output.forEach(line => console.log(line));
    }
    console.log(`(${this.id}) ${desc} finished with code ${code}`);
  }

  /**
   * Logs the given input data after processing it into individual lines.
   * Each non-empty line is prefixed with '--' and added to the output.
   *
   * @param {string} data - The input string containing data to be logged. If undefined, the method does nothing.
   * @return {void} This method does not return any value.
   */
  log(data) {
    if (data === undefined) {
      return;
    }
    const lines = data.split(/[\r\n\t]+/);
    lines.forEach(line => {
      if (line.length > 0) {
        this.output.push(`-- ${line}`);
      }
    });
  }

  /**
   * Handles error data by processing lines and appending formatted output to the `output` array.
   *
   * @param {string} data - The error data to be processed. Expects a string containing line-separated content.
   * @return {void} Returns nothing.
   */
  err(data) {
    if (data === undefined) {
      return;
    }
    const lines = data.split(/[\r\n\t]+/);
    lines.forEach(line => {
      if (line.length > 0) {
        this.output.push(`xx ${line}`);
      }
    });
  }
}