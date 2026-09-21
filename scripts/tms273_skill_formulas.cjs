#!/usr/bin/env node

// Small, source-expression evaluator for the currently selected TMS273 skills.
// It intentionally has no dynamic code execution and is not a general formula language.
// d()/u() follow WzComparerR2 Calculator.cs (fixed evidence commit
// 4b691cf55695fd13effdd0ba8f3826a8b6b81552): Math.Floor / Math.Ceiling.
// JS Number 足够覆盖当前这批小整数字面量与一位小数（源里有 `0.4` 这种写法）；
// 这**不**声称与 WzComparerR2 有任意精度十进制等价（例如 `0.1+0.2` 不保证等于 `0.3`）。

const assert = require('node:assert/strict');

const MAX_FORMULA_LENGTH = 256;
const MAX_NESTING = 32;

class FormulaParser {
  constructor(formula, level) {
    if (typeof formula !== 'string') throw new TypeError('formula must be a string');
    if (formula.length === 0) throw new SyntaxError('formula is empty');
    if (formula.length > MAX_FORMULA_LENGTH) throw new RangeError('formula is too long');
    this.formula = formula;
    this.level = level;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    if (this.index >= this.formula.length) throw new SyntaxError('formula is empty');
    const value = this.parseExpression(0);
    this.skipWhitespace();
    if (this.index !== this.formula.length) this.fail(`unexpected token at ${this.index}`);
    return this.finite(value);
  }

  parseExpression(depth) {
    let value = this.parseTerm(depth);
    while (true) {
      this.skipWhitespace();
      const operator = this.formula[this.index];
      if (operator !== '+' && operator !== '-') return value;
      this.index += 1;
      const right = this.parseTerm(depth);
      value = this.applyBinary(operator, value, right);
    }
  }

  parseTerm(depth) {
    let value = this.parseUnary(depth);
    while (true) {
      this.skipWhitespace();
      const operator = this.formula[this.index];
      if (operator !== '*' && operator !== '/') return value;
      this.index += 1;
      const right = this.parseUnary(depth);
      value = this.applyBinary(operator, value, right);
    }
  }

  parseUnary(depth) {
    this.skipWhitespace();
    const operator = this.formula[this.index];
    if (operator === '+' || operator === '-') {
      this.checkDepth(depth);
      this.index += 1;
      const value = this.parseUnary(depth + 1);
      return this.finite(operator === '-' ? -value : value);
    }
    return this.parsePrimary(depth);
  }

  parsePrimary(depth) {
    this.skipWhitespace();
    const character = this.formula[this.index];

    if (character === '(') {
      this.checkDepth(depth);
      this.index += 1;
      const value = this.parseExpression(depth + 1);
      this.skipWhitespace();
      if (this.formula[this.index] !== ')') this.fail(`missing ')' at ${this.index}`);
      this.index += 1;
      return value;
    }

    if ((character >= '0' && character <= '9') || character === '.') return this.parseNumber();

    if (isIdentifierStart(character)) {
      const name = this.parseIdentifier();
      if (name === 'x') return this.level;
      if (name !== 'd' && name !== 'u') this.fail(`unknown identifier '${name}'`);
      this.skipWhitespace();
      if (this.formula[this.index] !== '(') this.fail(`${name}() requires parentheses`);
      this.checkDepth(depth);
      this.index += 1;
      const value = this.parseExpression(depth + 1);
      this.skipWhitespace();
      if (this.formula[this.index] !== ')') this.fail(`missing ')' at ${this.index}`);
      this.index += 1;
      return this.finite(name === 'd' ? Math.floor(value) : Math.ceil(value));
    }

    if (character === undefined) this.fail(`expected expression at ${this.index}`);
    this.fail(`unexpected token '${character}' at ${this.index}`);
  }

  // 数字字面量。源里既有整数（`18+3*x`）也有小数（`0.4`，如 2111013 劇毒領域的 `t`），
  // 所以按小数接受；只认 `[0-9]+('.'[0-9]+)?` 与 `'.'[0-9]+`。
  // 刻意**不**接受科学计数法（`1e3` 仍是语法错误）与缺尾数的 `1.`：源里没有这种写法，
  // 放开只会把真语法错误吞掉。整数仍保留安全整数上界。
  parseNumber() {
    const start = this.index;
    while (this.index < this.formula.length && isDigit(this.formula[this.index])) this.index += 1;
    let fractional = false;
    if (this.formula[this.index] === '.') {
      fractional = true;
      this.index += 1;
      const digitsStart = this.index;
      while (this.index < this.formula.length && isDigit(this.formula[this.index])) this.index += 1;
      if (this.index === digitsStart) this.fail(`missing fractional digits at ${this.index}`);
    }
    if (this.index === start) this.fail(`expected number at ${this.index}`);
    const value = Number(this.formula.slice(start, this.index));
    if (!fractional && !Number.isSafeInteger(value)) this.fail(`integer out of range at ${start}`);
    if (!Number.isFinite(value)) this.fail(`number out of range at ${start}`);
    return value;
  }

  parseIdentifier() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.formula.length && isIdentifierPart(this.formula[this.index])) this.index += 1;
    return this.formula.slice(start, this.index);
  }

  applyBinary(operator, left, right) {
    if (operator === '/' && right === 0) throw new RangeError('division by zero');
    const value = operator === '+' ? left + right
      : operator === '-' ? left - right
        : operator === '*' ? left * right
          : left / right;
    return this.finite(value);
  }

  finite(value) {
    if (!Number.isFinite(value)) throw new RangeError('formula result is not finite');
    return value;
  }

  checkDepth(depth) {
    if (depth >= MAX_NESTING) throw new RangeError('formula nesting is too deep');
  }

  skipWhitespace() {
    while (this.index < this.formula.length && /\s/.test(this.formula[this.index])) this.index += 1;
  }

  fail(message) {
    throw new SyntaxError(message);
  }
}

function isIdentifierStart(character) {
  return typeof character === 'string' && /^[A-Za-z_]$/.test(character);
}

function isIdentifierPart(character) {
  return typeof character === 'string' && /^[A-Za-z0-9_]$/.test(character);
}

function isDigit(character) {
  return typeof character === 'string' && character >= '0' && character <= '9';
}

function validateLevel(level) {
  if (!Number.isSafeInteger(level) || level < 0) throw new RangeError('level must be a non-negative safe integer');
}

/**
 * Evaluate a bounded TMS273 source expression with `x` bound to `level`.
 * Supported grammar: decimal integers and decimals, x, + - * /, parentheses,
 * d(expr), u(expr), and unary +/-.
 * Returns a finite number; it does not enforce a skill's maxLevel.
 */
function evaluate(formula, level) {
  validateLevel(level);
  return new FormulaParser(formula, level).parse();
}

module.exports = { evaluate };

function selfCheck() {
  // Current source expressions: 魔靈彈, 電閃雷鳴, 冰錐劍.
  assert.equal(evaluate('16+2*d(x/5)', 0), 16);
  assert.equal(evaluate('16+2*d(x/5)', 20), 24);
  assert.equal(evaluate('18+3*x', 1), 21);
  assert.equal(evaluate('18+3*x', 20), 78);
  assert.equal(evaluate('20+5*d(x/4)', 1), 20);
  assert.equal(evaluate('20+5*d(x/4)', 10), 30);
  assert.equal(evaluate('130+8*x', 10), 210);
  assert.equal(evaluate('12+3*d(x/4)', 1), 12);
  assert.equal(evaluate('12+3*d(x/4)', 20), 27);
  assert.equal(evaluate('99+5*x', 20), 199);

  assert.equal(evaluate('1+2*3', 1), 7);
  assert.equal(evaluate('(1+2)*3', 1), 9);
  assert.equal(evaluate('2*-3+u(1/2)', 1), -5);
  assert.equal(evaluate('d(-3/2)', 1), -2);
  assert.equal(evaluate('u(-3/2)', 1), -1);

  // 小数：2111013 劇毒領域的 common.t 就是 `0.4`，整段公式里也允许小数参与运算。
  assert.equal(evaluate('0.4', 1), 0.4);
  assert.equal(evaluate('.5', 1), 0.5);
  assert.equal(evaluate('0.4*x', 10), 4);
  assert.equal(evaluate('1.5+2.25', 1), 3.75);

  for (const [formula, level] of [
    ['1/0', 1],
    ['1+', 1],
    ['1 2', 1],
    ['min(1,2)', 1],
    ['process.exit()', 1],
    ['1;process.exit()', 1],
    ['d(1', 1],
    ['1', -1],
    ['1', 1.5],
    ['1', Number.NaN],
    ['1', Number.POSITIVE_INFINITY],
    ['1', '1'],
    ['1.', 1],
    ['.', 1],
    ['1..2', 1],
  ]) assert.throws(() => evaluate(formula, level));
  assert.throws(() => evaluate('1'.repeat(MAX_FORMULA_LENGTH + 1), 1));
  assert.throws(() => evaluate(`${'('.repeat(MAX_NESTING + 1)}1${')'.repeat(MAX_NESTING + 1)}`, 1));
  assert.throws(() => evaluate('1e3', 1));
  assert.throws(() => evaluate('2**3', 1));
  console.log('tms273_skill_formulas: self-check passed');
}

if (require.main === module) selfCheck();
