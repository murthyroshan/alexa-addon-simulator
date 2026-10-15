import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsOf, fieldsOf } from '../src/schema';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Who' },
    note: { type: 'string', maxLength: 2000 },
    guests: { type: 'integer', default: 2 },
    tip: { type: 'number' },
    urgent: { type: 'boolean' },
    size: { type: 'string', enum: ['small', 'large'] },
    level: { type: 'integer', enum: [1, 2, 3] },
    when: { type: 'string', oneOf: [{ const: 'now', title: 'Right now' }, { const: 'later', title: 'Later' }] },
    toppings: { type: 'array', items: { type: 'string' } },
    extra: { type: 'object' },
    maybe: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  },
  required: ['name', 'urgent'],
};

test('every JSON Schema type becomes the right kind of field', () => {
  const kinds = Object.fromEntries(fieldsOf(schema).map((f) => [f.key, f.kind]));
  assert.deepEqual(kinds, { name: 'text', note: 'longtext', guests: 'integer', tip: 'number', urgent: 'boolean', size: 'choice', level: 'choice', when: 'choice', toppings: 'list', extra: 'json', maybe: 'number' });
  const fields = fieldsOf(schema);
  assert.equal(fields.find((f) => f.key === 'guests')?.initial, '2');
  assert.equal(fields.find((f) => f.key === 'urgent')?.initial, 'false', 'a required yes/no starts at no');
  assert.deepEqual(fields.find((f) => f.key === 'when')?.options, [{ value: 'now', label: 'Right now' }, { value: 'later', label: 'Later' }]);
  assert.equal(fields.find((f) => f.key === 'name')?.required, true);
});

test('values come back typed, and empty optional fields are left out', () => {
  const fields = fieldsOf(schema);
  const { args, errors } = argsOf(fields, { name: 'Priya', guests: '3', tip: '2.5', urgent: 'true', size: 'large', level: '2', when: 'now', toppings: 'cheese\n\n olives ', extra: '{"a":1}', note: '' });
  assert.deepEqual(errors, {});
  assert.deepEqual(args, { name: 'Priya', guests: 3, tip: 2.5, urgent: true, size: 'large', level: 2, when: 'now', toppings: ['cheese', 'olives'], extra: { a: 1 } });
});

test('what is wrong with the form, per field', () => {
  const { errors } = argsOf(fieldsOf(schema), { guests: '2.5', tip: 'lots', extra: '{oops', urgent: '' });
  assert.deepEqual(errors, { name: 'Required', guests: 'A whole number', tip: 'A number', urgent: 'Required', extra: 'Not valid JSON' });
});

test('no schema, no fields', () => {
  assert.deepEqual(fieldsOf(undefined), []);
  assert.deepEqual(argsOf([], {}), { args: {}, errors: {} });
});
