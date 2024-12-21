export class ConditionNotMet extends Error {
  constructor() {
    super('Condition not met');
  }
}