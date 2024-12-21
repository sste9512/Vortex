export class Unchanged extends Error {
  constructor() {
    super('No changes');
  }
}