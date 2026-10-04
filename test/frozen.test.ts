import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, restoreFrozenSentences, type FrozenRef } from '../src/organs/redaction';

const HEADER = 'Name: ada\nBorn: 2023-11-14T22:13:20.000Z';
const SCAR = `${PLACEHOLDER}(x)${PLACEHOLDER}(a)${PLACEHOLDER}`;

function body(...lines: string[]): string {
  return `${HEADER}\n${lines.join('\n')}`;
}

function ref(id: number, visible: string): FrozenRef {
  return { id, visible };
}

describe('restoring frozen sentences after a memory rewrite', () => {
  it('keeps a sentence the model left exactly as it was, and reports no repair', () => {
    const frozen = ref(1, `The vault code is ${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}.`);
    const text = body('I woke up hungry.', frozen.visible);
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.text).toBe(text);
    expect(result.replaced).toEqual([]);
    expect(result.inserted).toEqual([]);
    expect(result.strayRemoved).toBe(0);
  });

  it('finds a sentence the model filled in and puts the frozen text back in place', () => {
    const frozen = ref(1, `The vault code is ${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}.`);
    const filled = 'The vault code is 4471.';
    const text = body('I woke up hungry.', filled, 'I ate something.');
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.replaced).toEqual([1]);
    expect(result.inserted).toEqual([]);
    expect(result.text).toContain(frozen.visible);
    expect(result.text).not.toContain(filled);
    expect(result.text).toContain('I woke up hungry.');
    expect(result.text).toContain('I ate something.');
    expect(result.text.split('\n').length).toBe(text.split('\n').length);
  });

  it('puts a deleted sentence back after the previous frozen sentence, not at the end', () => {
    const first = ref(1, `First loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const second = ref(2, `Second loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const text = body('Something else happened.', first.visible, 'And then more happened.');
    const result = restoreFrozenSentences(text, [first, second]);
    expect(result.inserted).toEqual([2]);
    const lines = result.text.split('\n');
    expect(lines.indexOf(first.visible)).toBeGreaterThan(-1);
    expect(lines.indexOf(second.visible)).toBe(lines.indexOf(first.visible) + 1);
    expect(lines.indexOf(second.visible)).toBeLessThan(lines.indexOf('And then more happened.'));
  });

  it('inserts a missing first sentence after the Born line when there is no neighbour', () => {
    const frozen = ref(1, `The loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const text = body('Everything else is new text.');
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.inserted).toEqual([1]);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('Name: ada');
    expect(lines[1]).toBe('Born: 2023-11-14T22:13:20.000Z');
    expect(lines[2]).toBe(frozen.visible);
  });

  it('drops a sentence the model wrote twice', () => {
    const frozen = ref(1, `The loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const text = body(frozen.visible, 'Something else.', frozen.visible);
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.text.split(frozen.visible).length - 1).toBe(1);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.replaced).toEqual([]);
    expect(result.inserted).toEqual([]);
  });

  it('deletes placeholders the model invented outside every frozen sentence', () => {
    const frozen = ref(1, `The real loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const text = body(frozen.visible, 'A sentence the model tore by itself: ▮▮▮.', 'A clean end.');
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.strayRemoved).toBe(3);
    expect(result.text).not.toContain('▮▮▮.');
    expect(result.text).toContain(frozen.visible);
    expect(result.text).toContain('A clean end.');
  });

  it('leaves a scar in the middle of a frozen sentence alone', () => {
    const frozen = ref(1, `The scar: ${SCAR}.`);
    const text = body(frozen.visible);
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.text).toBe(text);
    expect(result.strayRemoved).toBe(0);
  });

  it('keeps the two header lines even when they carry a placeholder', () => {
    const frozen = ref(1, `A loss: ${PLACEHOLDER}.`);
    const text = `Name: ad${PLACEHOLDER}\nBorn: 2023-11-14T22:13:20.000Z\n${frozen.visible}`;
    const result = restoreFrozenSentences(text, [frozen]);
    expect(result.text.startsWith('Name: ad')).toBe(true);
    expect(result.text).toContain(frozen.visible);
  });
});
