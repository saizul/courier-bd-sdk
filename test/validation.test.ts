import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ValidationError } from '../src/errors.js';
import {
  DEFAULT_ORDER_RULES,
  checkCodAmount,
  checkCreateOrder,
  checkWeight,
  detectOperator,
  isValidPhone,
  normalizePhone,
  toAsciiDigits,
  toE164,
  validateChargeInput,
  validateCreateOrder,
} from '../src/validation.js';
import { sampleOrder } from './helpers/mock-fetch.js';

describe('normalizePhone', () => {
  const valid: Array<[string, unknown]> = [
    ['local 11-digit form', '01712345678'],
    ['+880 international form', '+8801712345678'],
    ['880 without plus', '8801712345678'],
    ['00880 international call prefix', '008801712345678'],
    ['spaces and hyphens', '+880 1712-345678'],
    ['parentheses and dots', '(+880) 1712.345.678'],
    ['10 digits without leading zero', '1712345678'],
    ['numeric input (leading zero lost)', 1712345678],
    ['Bangla digits', '০১৭১২৩৪৫৬৭৮'],
    ['Bangla digits with +880', '+৮৮০১৭১২৩৪৫৬৭৮'],
    ['redundant zero after country code', '+88001712345678'],
    ['surrounding whitespace', '  01712345678  '],
  ];
  for (const [label, input] of valid) {
    test(`accepts ${label}`, () => {
      assert.equal(normalizePhone(input), '01712345678');
    });
  }

  const invalid: Array<[string, unknown]> = [
    ['too short', '0171234567'],
    ['too long', '017123456789'],
    ['unassigned operator prefix 012', '01212345678'],
    ['landline number', '0212345678'],
    ['letters mixed in', '01712abc678'],
    ['another country code', '+919812345678'],
    ['empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['an object', { phone: '01712345678' }],
  ];
  for (const [label, input] of invalid) {
    test(`rejects ${label}`, () => {
      assert.equal(normalizePhone(input), undefined);
      assert.equal(isValidPhone(input), false);
    });
  }

  for (const prefix of ['013', '014', '015', '016', '017', '018', '019']) {
    test(`accepts operator prefix ${prefix}`, () => {
      assert.equal(normalizePhone(`${prefix}11223344`), `${prefix}11223344`);
    });
  }

  test('toE164 produces +880 form', () => {
    assert.equal(toE164('01812345678'), '+8801812345678');
    assert.equal(toE164('nope'), undefined);
  });

  test('toAsciiDigits converts Bangla and Arabic-Indic digits only', () => {
    assert.equal(toAsciiDigits('০১২৩৪৫৬৭৮৯'), '0123456789');
    assert.equal(toAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
    assert.equal(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
    assert.equal(toAsciiDigits('ফোন: ০১৭'), 'ফোন: 017');
  });

  test('detectOperator maps prefixes to original allocations', () => {
    assert.equal(detectOperator('01712345678'), 'Grameenphone');
    assert.equal(detectOperator('01312345678'), 'Grameenphone');
    assert.equal(detectOperator('01812345678'), 'Robi');
    assert.equal(detectOperator('01612345678'), 'Airtel');
    assert.equal(detectOperator('01912345678'), 'Banglalink');
    assert.equal(detectOperator('01512345678'), 'Teletalk');
    assert.equal(detectOperator('12345'), undefined);
  });
});

describe('checkCodAmount', () => {
  const rules = { codMax: 1000, codInteger: false };
  test('accepts zero for prepaid orders', () => {
    assert.deepEqual(checkCodAmount(0, rules), []);
  });
  test('accepts two decimal places', () => {
    assert.deepEqual(checkCodAmount(99.99, rules), []);
  });
  test('rejects negative amounts', () => {
    assert.equal(checkCodAmount(-1, rules)[0]?.code, 'negative_cod');
  });
  test('rejects NaN, Infinity and non-numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined]) {
      assert.equal(checkCodAmount(value, rules)[0]?.code, 'invalid_cod');
    }
  });
  test('rejects amounts above the limit', () => {
    assert.equal(checkCodAmount(1000.01, rules)[0]?.code, 'cod_too_large');
  });
  test('rejects more than two decimals', () => {
    assert.equal(checkCodAmount(10.123, rules)[0]?.code, 'cod_precision');
  });
  test('rejects fractional amounts when the courier needs whole taka', () => {
    assert.equal(checkCodAmount(10.5, { codMax: 1000, codInteger: true })[0]?.code, 'cod_not_integer');
    assert.deepEqual(checkCodAmount(10, { codMax: 1000, codInteger: true }), []);
  });
});

describe('checkWeight', () => {
  const rules = { weightMinKg: 0.5, weightMaxKg: 10 };
  test('accepts the boundaries', () => {
    assert.deepEqual(checkWeight(0.5, rules), []);
    assert.deepEqual(checkWeight(10, rules), []);
  });
  test('rejects zero and negative weight', () => {
    assert.equal(checkWeight(0, rules)[0]?.code, 'invalid_weight');
    assert.equal(checkWeight(-2, rules)[0]?.code, 'invalid_weight');
  });
  test('rejects weight below the minimum', () => {
    assert.equal(checkWeight(0.2, rules)[0]?.code, 'weight_too_small');
  });
  test('rejects weight above the maximum', () => {
    assert.equal(checkWeight(10.5, rules)[0]?.code, 'weight_too_large');
  });
  test('rejects non-numeric weight', () => {
    assert.equal(checkWeight('1', rules)[0]?.code, 'invalid_weight');
  });
});

describe('validateCreateOrder', () => {
  test('normalizes phone, trims text and applies defaults', () => {
    const order = validateCreateOrder(
      sampleOrder({
        merchantOrderId: '  INV-7  ',
        weightKg: undefined,
        note: '  call   before delivery ',
        recipient: { name: '  Rahim   Uddin ', phone: '+880 1712-345678', secondaryPhone: '০১৮১২৩৪৫৬৭৮' },
      }),
    );
    assert.equal(order.merchantOrderId, 'INV-7');
    assert.equal(order.recipient.name, 'Rahim Uddin');
    assert.equal(order.recipient.phone, '01712345678');
    assert.equal(order.recipient.secondaryPhone, '01812345678');
    assert.equal(order.weightKg, DEFAULT_ORDER_RULES.defaultWeightKg);
    assert.equal(order.quantity, 1);
    assert.equal(order.itemType, 'parcel');
    assert.equal(order.deliveryType, 'normal');
    assert.equal(order.note, 'call before delivery');
  });

  test('does not mutate the caller input', () => {
    const input = sampleOrder({ recipient: { phone: '+8801712345678' } });
    const snapshot = structuredClone(input);
    validateCreateOrder(input);
    assert.deepEqual(input, snapshot);
  });

  test('reports every issue at once', () => {
    const { issues } = checkCreateOrder({
      merchantOrderId: '',
      recipient: { name: 'A', phone: '123', address: 'short' },
      codAmount: -5,
      weightKg: 500,
      quantity: 0,
    });
    const fields = issues.map((issue) => issue.field).sort();
    assert.deepEqual(fields, [
      'codAmount',
      'merchantOrderId',
      'quantity',
      'recipient.address',
      'recipient.name',
      'recipient.phone',
      'weightKg',
    ]);
  });

  test('throws ValidationError carrying issues and provider', () => {
    assert.throws(
      () => validateCreateOrder(sampleOrder({ recipient: { phone: 'bad' } }), DEFAULT_ORDER_RULES, 'pathao'),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.provider, 'pathao');
        assert.equal(error.code, 'VALIDATION');
        assert.equal(error.issues[0]?.field, 'recipient.phone');
        assert.equal(error.issues[0]?.code, 'invalid_phone');
        return true;
      },
    );
  });

  test('address length is enforced at both ends', () => {
    const long = 'x'.repeat(DEFAULT_ORDER_RULES.addressMaxLength + 1);
    assert.equal(checkCreateOrder(sampleOrder({ recipient: { address: long } })).issues[0]?.code, 'too_long');
    assert.equal(checkCreateOrder(sampleOrder({ recipient: { address: 'Dhaka' } })).issues[0]?.code, 'too_short');
  });

  test('address length counts Bangla characters, not UTF-16 units', () => {
    const address = 'বাড়ি ১২, রোড ৫, ধানমন্ডি, ঢাকা';
    assert.deepEqual(checkCreateOrder(sampleOrder({ recipient: { address } })).issues, []);
  });

  test('missing recipient object yields required issues instead of a crash', () => {
    const { issues } = checkCreateOrder({ merchantOrderId: 'X1', codAmount: 10 } as never);
    assert.ok(issues.some((issue) => issue.field === 'recipient.name' && issue.code === 'required'));
    assert.ok(issues.some((issue) => issue.field === 'recipient.phone' && issue.code === 'required'));
  });

  test('rejects an invalid secondary phone but allows it to be omitted', () => {
    assert.equal(
      checkCreateOrder(sampleOrder({ recipient: { secondaryPhone: '555' } })).issues[0]?.field,
      'recipient.secondaryPhone',
    );
    assert.deepEqual(checkCreateOrder(sampleOrder({ recipient: { secondaryPhone: '' } })).issues, []);
  });

  test('rejects unknown item and delivery types', () => {
    const { issues } = checkCreateOrder(sampleOrder({ itemType: 'liquid', deliveryType: 'teleport' }));
    assert.deepEqual(issues.map((issue) => issue.code), ['invalid_item_type', 'invalid_delivery_type']);
  });

  test('enforces a merchant order id pattern when the rule defines one', () => {
    const rules = { ...DEFAULT_ORDER_RULES, merchantOrderIdPattern: /^[A-Za-z0-9_-]+$/ };
    assert.equal(checkCreateOrder(sampleOrder({ merchantOrderId: 'INV 1/2' }), rules).issues[0]?.code, 'invalid_format');
    assert.deepEqual(checkCreateOrder(sampleOrder({ merchantOrderId: 'INV_1-2' }), rules).issues, []);
  });

  test('rejects an over-long note and a negative declared value', () => {
    const { issues } = checkCreateOrder(sampleOrder({ note: 'n'.repeat(401), declaredValue: -1 }));
    assert.deepEqual(issues.map((issue) => issue.field), ['note', 'declaredValue']);
  });
});

describe('validateChargeInput', () => {
  test('defaults COD to zero', () => {
    assert.equal(validateChargeInput({ weightKg: 1 }).codAmount, 0);
  });
  test('rejects a missing weight', () => {
    assert.throws(() => validateChargeInput({} as never), ValidationError);
  });
  test('rejects a negative COD', () => {
    assert.throws(() => validateChargeInput({ weightKg: 1, codAmount: -1 }), ValidationError);
  });
});
