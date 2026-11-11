import { ValidationError, type ValidationIssue } from './errors.js';
import type { ChargeInput, CreateOrderInput, DeliveryType, ItemType, Recipient } from './types.js';

/* -------------------------------------------------------------------------- */
/* Phone numbers                                                              */
/* -------------------------------------------------------------------------- */

const NON_ASCII_DIGITS = /[٠-٩۰-۹০-৯]/g;

/**
 * Convert Bangla (০-৯), Arabic-Indic and Extended Arabic-Indic digits to
 * ASCII. Other characters are left untouched.
 */
export function toAsciiDigits(text: string): string {
  return text.replace(NON_ASCII_DIGITS, (char) => {
    const code = char.charCodeAt(0);
    const zero = code >= 0x09e6 ? 0x09e6 : code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - zero);
  });
}

const LOCAL_MOBILE = /^01[3-9]\d{8}$/;

/**
 * Normalize a Bangladesh mobile number to the 11-digit local form
 * `01XXXXXXXXX`. Returns `undefined` when the input is not a valid mobile
 * number.
 *
 * Accepted inputs include `01712345678`, `+8801712345678`, `8801712345678`,
 * `008801712345678`, `+880 1712-345678`, `1712345678` and any of these
 * written with Bangla digits.
 */
export function normalizePhone(input: unknown): string | undefined {
  if (typeof input !== 'string' && typeof input !== 'number') return undefined;
  const text = toAsciiDigits(String(input)).trim();
  if (text === '' || !/^\(?\+?[\d\s\-().]+$/.test(text)) return undefined;
  let digits = text.replace(/\D/g, '');
  if (/^\(?\+/.test(text) && !digits.startsWith('880')) return undefined;
  if (digits.startsWith('00880')) digits = digits.slice(2);
  if (digits.startsWith('880')) {
    digits = digits.slice(3);
    if (!digits.startsWith('0')) digits = `0${digits}`;
  } else if (digits.length === 10 && digits.startsWith('1')) {
    digits = `0${digits}`;
  }
  return LOCAL_MOBILE.test(digits) ? digits : undefined;
}

export function isValidPhone(input: unknown): boolean {
  return normalizePhone(input) !== undefined;
}

/** `+8801XXXXXXXXX`, or `undefined` for invalid input. */
export function toE164(input: unknown): string | undefined {
  const local = normalizePhone(input);
  return local === undefined ? undefined : `+88${local}`;
}

export type MobileOperator = 'Grameenphone' | 'Robi' | 'Airtel' | 'Banglalink' | 'Teletalk';

const OPERATOR_PREFIXES: Readonly<Record<string, MobileOperator>> = {
  '013': 'Grameenphone',
  '017': 'Grameenphone',
  '014': 'Banglalink',
  '019': 'Banglalink',
  '018': 'Robi',
  '016': 'Airtel',
  '015': 'Teletalk',
};

/**
 * Operator the number range was originally allocated to. Number portability
 * means the subscriber may have moved since, so treat this as a hint only.
 */
export function detectOperator(input: unknown): MobileOperator | undefined {
  const local = normalizePhone(input);
  return local === undefined ? undefined : OPERATOR_PREFIXES[local.slice(0, 3)];
}

/* -------------------------------------------------------------------------- */
/* Order rules                                                                */
/* -------------------------------------------------------------------------- */

export interface OrderRules {
  nameMinLength: number;
  nameMaxLength: number;
  addressMinLength: number;
  addressMaxLength: number;
  /** Lightest accepted parcel in kg. */
  weightMinKg: number;
  /** Heaviest accepted parcel in kg. */
  weightMaxKg: number;
  /** Applied when the order does not state a weight. */
  defaultWeightKg: number;
  /** Largest accepted COD amount in BDT. */
  codMax: number;
  /** Require whole-taka COD amounts. */
  codInteger: boolean;
  merchantOrderIdMaxLength: number;
  /** When set, the merchant order id must match this pattern. */
  merchantOrderIdPattern?: RegExp;
  noteMaxLength: number;
  quantityMax: number;
}

/**
 * Conservative defaults. Each adapter layers its own limits on top and users
 * can override any rule through the client's `rules` option.
 */
export const DEFAULT_ORDER_RULES: Readonly<OrderRules> = Object.freeze({
  nameMinLength: 2,
  nameMaxLength: 100,
  addressMinLength: 10,
  addressMaxLength: 250,
  weightMinKg: 0.05,
  weightMaxKg: 25,
  defaultWeightKg: 0.5,
  codMax: 500_000,
  codInteger: false,
  merchantOrderIdMaxLength: 64,
  noteMaxLength: 400,
  quantityMax: 1000,
});

/** A validated order with defaults applied and strings cleaned up. */
export interface NormalizedOrderInput extends CreateOrderInput {
  recipient: Recipient;
  weightKg: number;
  quantity: number;
  itemType: ItemType;
  deliveryType: DeliveryType;
}

const ITEM_TYPES: readonly ItemType[] = ['parcel', 'document'];
const DELIVERY_TYPES: readonly DeliveryType[] = ['normal', 'express'];

/** Collapse internal whitespace and trim; non-strings become ''. */
export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function hasMoreThanTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) > 1e-6;
}

/** Issues for a COD amount; empty when valid. */
export function checkCodAmount(value: unknown, rules: Pick<OrderRules, 'codMax' | 'codInteger'>, field = 'codAmount'): ValidationIssue[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [{ field, code: 'invalid_cod', message: 'COD amount must be a finite number' }];
  }
  if (value < 0) return [{ field, code: 'negative_cod', message: 'COD amount cannot be negative' }];
  if (value > rules.codMax) {
    return [{ field, code: 'cod_too_large', message: `COD amount cannot exceed ${rules.codMax} BDT` }];
  }
  if (rules.codInteger && !Number.isInteger(value)) {
    return [{ field, code: 'cod_not_integer', message: 'COD amount must be a whole number of taka for this courier' }];
  }
  if (hasMoreThanTwoDecimals(value)) {
    return [{ field, code: 'cod_precision', message: 'COD amount cannot have more than two decimal places' }];
  }
  return [];
}

/** Issues for a weight in kilograms; empty when valid. */
export function checkWeight(value: unknown, rules: Pick<OrderRules, 'weightMinKg' | 'weightMaxKg'>, field = 'weightKg'): ValidationIssue[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return [{ field, code: 'invalid_weight', message: 'Weight must be a finite number of kilograms' }];
  }
  if (value <= 0) return [{ field, code: 'invalid_weight', message: 'Weight must be greater than zero' }];
  if (value < rules.weightMinKg) {
    return [{ field, code: 'weight_too_small', message: `Weight must be at least ${rules.weightMinKg} kg` }];
  }
  if (value > rules.weightMaxKg) {
    return [{ field, code: 'weight_too_large', message: `Weight cannot exceed ${rules.weightMaxKg} kg` }];
  }
  return [];
}

function checkLength(value: string, min: number, max: number, field: string, label: string): ValidationIssue[] {
  // Count code points so Bangla text is measured the way a human would count it.
  const length = [...value].length;
  if (length === 0) return [{ field, code: 'required', message: `${label} is required` }];
  if (length < min) return [{ field, code: 'too_short', message: `${label} must be at least ${min} characters` }];
  if (length > max) return [{ field, code: 'too_long', message: `${label} cannot exceed ${max} characters` }];
  return [];
}

export interface OrderCheck {
  issues: ValidationIssue[];
  /** Only meaningful when `issues` is empty. */
  normalized: NormalizedOrderInput;
}

/**
 * Validate an order against `rules` without throwing. Returns every issue
 * found (not just the first) along with the normalized order.
 */
export function checkCreateOrder(input: CreateOrderInput, rules: OrderRules = DEFAULT_ORDER_RULES): OrderCheck {
  const issues: ValidationIssue[] = [];
  const source = (input ?? {}) as Partial<CreateOrderInput>;
  const recipientIn = (source.recipient ?? {}) as Partial<Recipient>;

  const merchantOrderId = cleanText(typeof source.merchantOrderId === 'number' ? String(source.merchantOrderId) : source.merchantOrderId);
  if (merchantOrderId === '') {
    issues.push({ field: 'merchantOrderId', code: 'required', message: 'Merchant order id is required' });
  } else if (merchantOrderId.length > rules.merchantOrderIdMaxLength) {
    issues.push({
      field: 'merchantOrderId',
      code: 'too_long',
      message: `Merchant order id cannot exceed ${rules.merchantOrderIdMaxLength} characters`,
    });
  } else if (rules.merchantOrderIdPattern && !rules.merchantOrderIdPattern.test(merchantOrderId)) {
    issues.push({
      field: 'merchantOrderId',
      code: 'invalid_format',
      message: 'Merchant order id contains characters this courier does not accept',
    });
  }

  const name = cleanText(recipientIn.name);
  issues.push(...checkLength(name, rules.nameMinLength, rules.nameMaxLength, 'recipient.name', 'Recipient name'));

  const address = cleanText(recipientIn.address);
  issues.push(
    ...checkLength(address, rules.addressMinLength, rules.addressMaxLength, 'recipient.address', 'Recipient address'),
  );

  const phone = normalizePhone(recipientIn.phone);
  if (phone === undefined) {
    issues.push({
      field: 'recipient.phone',
      code: recipientIn.phone === undefined || recipientIn.phone === '' ? 'required' : 'invalid_phone',
      message: 'Recipient phone must be a valid Bangladesh mobile number (01XXXXXXXXX)',
    });
  }

  let secondaryPhone: string | undefined;
  if (recipientIn.secondaryPhone !== undefined && recipientIn.secondaryPhone !== '') {
    secondaryPhone = normalizePhone(recipientIn.secondaryPhone);
    if (secondaryPhone === undefined) {
      issues.push({
        field: 'recipient.secondaryPhone',
        code: 'invalid_phone',
        message: 'Secondary phone must be a valid Bangladesh mobile number (01XXXXXXXXX)',
      });
    }
  }

  issues.push(...checkCodAmount(source.codAmount, rules));

  const weightKg = source.weightKg ?? rules.defaultWeightKg;
  issues.push(...checkWeight(weightKg, rules));

  const quantity = source.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) {
    issues.push({ field: 'quantity', code: 'invalid_quantity', message: 'Quantity must be a positive integer' });
  } else if (quantity > rules.quantityMax) {
    issues.push({ field: 'quantity', code: 'quantity_too_large', message: `Quantity cannot exceed ${rules.quantityMax}` });
  }

  const itemType = source.itemType ?? 'parcel';
  if (!ITEM_TYPES.includes(itemType)) {
    issues.push({ field: 'itemType', code: 'invalid_item_type', message: `Item type must be one of: ${ITEM_TYPES.join(', ')}` });
  }
  const deliveryType = source.deliveryType ?? 'normal';
  if (!DELIVERY_TYPES.includes(deliveryType)) {
    issues.push({
      field: 'deliveryType',
      code: 'invalid_delivery_type',
      message: `Delivery type must be one of: ${DELIVERY_TYPES.join(', ')}`,
    });
  }

  const note = cleanText(source.note);
  if ([...note].length > rules.noteMaxLength) {
    issues.push({ field: 'note', code: 'too_long', message: `Note cannot exceed ${rules.noteMaxLength} characters` });
  }

  if (source.declaredValue !== undefined) {
    if (typeof source.declaredValue !== 'number' || !Number.isFinite(source.declaredValue) || source.declaredValue < 0) {
      issues.push({ field: 'declaredValue', code: 'invalid_value', message: 'Declared value must be a non-negative number' });
    }
  }

  const recipient: Recipient = { ...recipientIn, name, address, phone: phone ?? '' };
  if (secondaryPhone !== undefined) recipient.secondaryPhone = secondaryPhone;
  else delete recipient.secondaryPhone;
  if (recipientIn.areaName !== undefined) recipient.areaName = cleanText(recipientIn.areaName);

  const normalized: NormalizedOrderInput = {
    ...(source as CreateOrderInput),
    merchantOrderId,
    recipient,
    codAmount: source.codAmount as number,
    weightKg,
    quantity,
    itemType,
    deliveryType,
  };
  if (note !== '') normalized.note = note;
  else delete normalized.note;
  const description = cleanText(source.itemDescription);
  if (description !== '') normalized.itemDescription = description;
  else delete normalized.itemDescription;

  return { issues, normalized };
}

function summarize(issues: readonly ValidationIssue[]): string {
  const first = issues[0];
  if (!first) return 'Validation failed';
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  return `${first.message}${more}`;
}

/** Validate and normalize an order, throwing {@link ValidationError} listing every issue. */
export function validateCreateOrder(
  input: CreateOrderInput,
  rules: OrderRules = DEFAULT_ORDER_RULES,
  provider?: string,
): NormalizedOrderInput {
  const { issues, normalized } = checkCreateOrder(input, rules);
  if (issues.length > 0) throwIssues(issues, provider);
  return normalized;
}

/** Throw a {@link ValidationError} for the given issues. */
export function throwIssues(issues: readonly ValidationIssue[], provider?: string): never {
  throw new ValidationError(`${provider ? `[${provider}] ` : ''}Invalid input: ${summarize(issues)}`, {
    issues,
    ...(provider !== undefined ? { provider } : {}),
  });
}

/** Validate the provider-independent parts of a charge request. */
export function validateChargeInput(
  input: ChargeInput,
  rules: OrderRules = DEFAULT_ORDER_RULES,
  provider?: string,
): ChargeInput & { codAmount: number } {
  const issues: ValidationIssue[] = [];
  const source = (input ?? {}) as Partial<ChargeInput>;
  issues.push(...checkWeight(source.weightKg, rules));
  const codAmount = source.codAmount ?? 0;
  issues.push(...checkCodAmount(codAmount, { codMax: rules.codMax, codInteger: false }));
  if (issues.length > 0) throwIssues(issues, provider);
  return { ...(source as ChargeInput), codAmount };
}
