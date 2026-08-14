import { describe, expect, test } from 'bun:test';
import { buildSmoothLinePath } from './UsageAreaChart';

describe('buildSmoothLinePath', () => {
  test('uses bounded cubic segments instead of jagged straight lines', () => {
    expect(buildSmoothLinePath([
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
    ])).toBe('M0,10 C5,10 5,0 10,0 C15,0 15,10 20,10');
    expect(buildSmoothLinePath([{ x: 4, y: 8 }])).toBe('M4,8');
  });
});
