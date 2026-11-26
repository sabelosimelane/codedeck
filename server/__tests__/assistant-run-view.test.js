import { describe, expect, it } from 'vitest';
import { createRunViewBuilder } from '../pipelines/run-view.js';

describe('createRunViewBuilder', () => {
  it('requires the stores needed to build the existing route view', () => {
    expect(() => createRunViewBuilder({})).toThrow('runStore');
  });
});
