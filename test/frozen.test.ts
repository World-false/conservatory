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

  it('keeps both of two frozen sentences that read exactly the same (#4)', () => {
    const first = ref(1, `The vault is ${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}.`);
    const second = ref(2, first.visible);
    const text = body(first.visible, second.visible);

    const result = restoreFrozenSentences(text, [first, second]);

    // Two ledger sentences, two copies on disk: neither is the other's
    // duplicate, and the second one is not deleted as a model invention.
    expect(result.text.split(first.visible).length - 1).toBe(2);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.inserted).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('repairs a sentence its identical twin left standing, and drops only the extra copy', () => {
    const first = ref(1, `The vault is ${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}.`);
    const second = ref(2, first.visible);
    // The model wrote three copies: two for the ledger's two sentences, one of
    // its own invention.
    const text = body(first.visible, first.visible, first.visible);

    const result = restoreFrozenSentences(text, [first, second]);

    expect(result.text.split(first.visible).length - 1).toBe(2);
    expect(result.duplicatesRemoved).toBe(1);
  });

  it('keeps a short placeholder-only sentence that sits inside a longer one (#4)', () => {
    // The four placeholders of `short` also occur inside `long`. The ledger
    // order matches the file, so the only question is that neither sentence is
    // mistaken for a copy of the other.
    const long = ref(1, `The vault is ${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}.`);
    const short = ref(2, `${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}`);
    const text = body(long.visible, short.visible);

    const result = restoreFrozenSentences(text, [long, short]);

    expect(result.text).toBe(text);
    expect(result.duplicatesRemoved).toBe(0);
    expect(result.strayRemoved).toBe(0);
    expect(result.replaced).toEqual([]);
  });

  it('puts a reordered pair back into the ledger order and records both ids (#17)', () => {
    const first = ref(1, `First loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const second = ref(2, `Second loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    // The model moved the two apart: the ledger has [first, second], the file
    // has them the other way round. Nothing was deleted and nothing changed.
    const text = body(second.visible, first.visible);

    const result = restoreFrozenSentences(text, [first, second]);

    const lines = result.text.split('\n');
    expect(lines[2]).toBe(first.visible);
    expect(lines[3]).toBe(second.visible);
    expect(result.replaced.sort((left, right) => left - right)).toEqual([1, 2]);
    expect(result.inserted).toEqual([]);
  });

  it('reports no repair when a reordered pair reads exactly the same either way', () => {
    const first = ref(1, `Same loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const second = ref(2, first.visible);
    const text = body(first.visible, second.visible);

    const result = restoreFrozenSentences(text, [first, second]);

    // The swap is invisible on disk, so there is nothing to repair and nothing
    // to report: the promise is the text, not the bytes.
    expect(result.text).toBe(text);
    expect(result.replaced).toEqual([]);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it('inserts a missing sentence inside `# WHO I AM`, not above its heading (#17)', () => {
    const frozen = ref(1, `The loss: ${PLACEHOLDER}${PLACEHOLDER}.`);
    const text = `${HEADER}\n\n# WHO I AM\n\n# RECENT ROUNDS\n\n## Round 1 — 2023-11-14T22:14:20.000Z\nI woke up.`;

    const result = restoreFrozenSentences(text, [frozen]);

    expect(result.inserted).toEqual([1]);
    const heading = result.text.indexOf('# WHO I AM');
    const recent = result.text.indexOf('# RECENT ROUNDS');
    const at = result.text.indexOf(frozen.visible);
    expect(at).toBeGreaterThan(heading);
    expect(at).toBeLessThan(recent);
  });
});
