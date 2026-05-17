import { HttpError } from "../errors.js";

/** One validation problem collected while decoding request input. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Structured 400 error raised at the boundary when request input fails validation. */
export class ValidationError extends HttpError {
  constructor(
    public readonly issues: readonly ValidationIssue[],
    message = "Invalid request",
  ) {
    super(400, message, { error: message, issues });
    this.name = "ValidationError";
  }
}

/** Typed value check that runs after structural decoding succeeds. */
export interface Validator<A> {
  validate(value: A): readonly ValidationIssue[];
}

function createValidator<A>(
  validate: (value: A) => readonly ValidationIssue[],
): Validator<A> {
  return { validate };
}

function singleIssue(message: string): readonly ValidationIssue[] {
  return [{ path: "", message }];
}

function noIssues(): readonly ValidationIssue[] {
  return [];
}

function refineValidator<A>(
  predicate: (value: A) => boolean,
  message: string | ((value: A) => string),
): Validator<A> {
  return createValidator((value) =>
    predicate(value)
      ? noIssues()
      : singleIssue(typeof message === "function" ? message(value) : message),
  );
}

function minValueValidator(
  min: number | bigint,
): Validator<number | bigint> {
  return createValidator((value) =>
    compareNumeric(value, min) >= 0
      ? noIssues()
      : singleIssue(`Expected a value greater than or equal to ${String(min)}.`),
  );
}

function maxValueValidator(
  max: number | bigint,
): Validator<number | bigint> {
  return createValidator((value) =>
    compareNumeric(value, max) <= 0
      ? noIssues()
      : singleIssue(`Expected a value less than or equal to ${String(max)}.`),
  );
}

function minValueExclusiveValidator(
  min: number | bigint,
): Validator<number | bigint> {
  return createValidator((value) =>
    compareNumeric(value, min) > 0
      ? noIssues()
      : singleIssue(`Expected a value greater than ${String(min)}.`),
  );
}

function maxValueExclusiveValidator(
  max: number | bigint,
): Validator<number | bigint> {
  return createValidator((value) =>
    compareNumeric(value, max) < 0
      ? noIssues()
      : singleIssue(`Expected a value less than ${String(max)}.`),
  );
}

function minLengthValidator(
  min: number,
): Validator<{ readonly length: number }> {
  return createValidator((value) =>
    value.length >= min
      ? noIssues()
      : singleIssue(`Expected length greater than or equal to ${min}.`),
  );
}

function maxLengthValidator(
  max: number,
): Validator<{ readonly length: number }> {
  return createValidator((value) =>
    value.length <= max
      ? noIssues()
      : singleIssue(`Expected length less than or equal to ${max}.`),
  );
}

function minItemsValidator<A>(
  min: number,
): Validator<readonly A[]> {
  return createValidator((value) =>
    value.length >= min
      ? noIssues()
      : singleIssue(`Expected at least ${min} item(s).`),
  );
}

function maxItemsValidator<A>(
  max: number,
): Validator<readonly A[]> {
  return createValidator((value) =>
    value.length <= max
      ? noIssues()
      : singleIssue(`Expected at most ${max} item(s).`),
  );
}

function patternValidator(
  pattern: string,
  message = `Expected to match pattern ${pattern}.`,
): Validator<string | Uint8Array> {
  const regex = new RegExp(pattern);
  const decoder = new TextDecoder();
  return createValidator((value) => {
    const text = typeof value === "string" ? value : decoder.decode(value);
    return regex.test(text) ? noIssues() : singleIssue(message);
  });
}

function compareNumeric(
  value: number | bigint,
  limit: number | bigint,
): number {
  if (typeof value === "bigint" || typeof limit === "bigint") {
    const left = typeof value === "bigint" ? value : BigInt(value);
    const right = typeof limit === "bigint" ? limit : BigInt(limit);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  return value < limit ? -1 : value > limit ? 1 : 0;
}

export const Validators = {
  refine: refineValidator,
  minValue: minValueValidator,
  maxValue: maxValueValidator,
  minValueExclusive: minValueExclusiveValidator,
  maxValueExclusive: maxValueExclusiveValidator,
  minLength: minLengthValidator,
  maxLength: maxLengthValidator,
  minItems: minItemsValidator,
  maxItems: maxItemsValidator,
  pattern: patternValidator,
} as const;
