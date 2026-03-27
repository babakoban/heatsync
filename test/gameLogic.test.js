const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateZones, classifyZones, zoneDelta, validateAllocation, determineWinners } = require('../lib/gameLogic');

// ─── aggregateZones ────────────────────────────────────────────────────────────

describe('aggregateZones', () => {
  test('sums crew + resources across all players per zone', () => {
    const allocs = new Map([
      ['Alice', { east: { crew: 1, resources: 2 }, west: { crew: 1, resources: 0 }, downtown: { crew: 0, resources: 0 } }],
      ['Bob',   { east: { crew: 0, resources: 0 }, west: { crew: 1, resources: 1 }, downtown: { crew: 1, resources: 3 } }],
    ]);
    const totals = aggregateZones(allocs);
    assert.deepEqual(totals, { east: 3, west: 3, downtown: 4 });
  });

  test('returns zeros for empty allocations', () => {
    assert.deepEqual(aggregateZones(new Map()), { east: 0, west: 0, downtown: 0 });
  });
});

// ─── classifyZones ────────────────────────────────────────────────────────────

describe('classifyZones', () => {
  test('all different — assigns lowest/middle/highest correctly', () => {
    const result = classifyZones({ east: 1, west: 3, downtown: 5 });
    assert.equal(result.outcome, 'all_different');
    assert.equal(result.roles.east, 'lowest');
    assert.equal(result.roles.west, 'middle');
    assert.equal(result.roles.downtown, 'highest');
  });

  test('all tied', () => {
    const result = classifyZones({ east: 4, west: 4, downtown: 4 });
    assert.equal(result.outcome, 'all_tied');
    assert.equal(result.roles.east, 'tied');
    assert.equal(result.roles.west, 'tied');
    assert.equal(result.roles.downtown, 'tied');
  });

  test('two tied for lowest', () => {
    const result = classifyZones({ east: 2, west: 2, downtown: 6 });
    assert.equal(result.outcome, 'two_tied_lowest');
    assert.equal(result.roles.east, 'tied_lowest');
    assert.equal(result.roles.west, 'tied_lowest');
    assert.equal(result.roles.downtown, 'lone_highest');
  });

  test('two tied for highest', () => {
    const result = classifyZones({ east: 5, west: 5, downtown: 1 });
    assert.equal(result.outcome, 'two_tied_highest');
    assert.equal(result.roles.east, 'tied_highest');
    assert.equal(result.roles.west, 'tied_highest');
    assert.equal(result.roles.downtown, 'lone_lowest');
  });
});

// ─── zoneDelta ────────────────────────────────────────────────────────────────

describe('zoneDelta', () => {
  test('highest: lose resources + 1 for crew recovery', () => {
    assert.equal(zoneDelta(1, 2, 'highest', 'all_different'), -3);
    assert.equal(zoneDelta(1, 0, 'highest', 'all_different'), -1);
  });

  test('lone_highest behaves like highest', () => {
    assert.equal(zoneDelta(1, 3, 'lone_highest', 'two_tied_lowest'), -4);
  });

  test('middle: gain 1', () => {
    assert.equal(zoneDelta(1, 0, 'middle', 'all_different'), 1);
    assert.equal(zoneDelta(1, 5, 'middle', 'all_different'), 1);
  });

  test('lowest: triple — net = 3 + 2*res', () => {
    assert.equal(zoneDelta(1, 0, 'lowest', 'all_different'), 3);
    assert.equal(zoneDelta(1, 2, 'lowest', 'all_different'), 7);
  });

  test('lone_lowest behaves like lowest', () => {
    assert.equal(zoneDelta(1, 1, 'lone_lowest', 'two_tied_highest'), 5);
  });

  test('tied_lowest: double — net = 2 + res', () => {
    assert.equal(zoneDelta(1, 0, 'tied_lowest', 'two_tied_lowest'), 2);
    assert.equal(zoneDelta(1, 3, 'tied_lowest', 'two_tied_lowest'), 5);
  });

  test('tied_highest: halve — net = floor((1+res)/2) - res', () => {
    assert.equal(zoneDelta(1, 2, 'tied_highest', 'two_tied_highest'), -1); // floor(3/2)-2 = -1
    assert.equal(zoneDelta(1, 4, 'tied_highest', 'two_tied_highest'), -2); // floor(5/2)-4 = -2
  });

  test('tied_highest crew-only (res=0): returns 0 — crew penalty applied separately', () => {
    // floor(1/2) - 0 = 0; the -1 resource penalty is handled post-calc in resolveRound
    assert.equal(zoneDelta(1, 0, 'tied_highest', 'two_tied_highest'), 0);
  });

  test('all_tied with resources: -1 (crackdown)', () => {
    assert.equal(zoneDelta(1, 1, 'tied', 'all_tied'), -1);
    assert.equal(zoneDelta(1, 3, 'tied', 'all_tied'), -1);
  });

  test('all_tied crew-only: 0 (safe)', () => {
    assert.equal(zoneDelta(1, 0, 'tied', 'all_tied'), 0);
  });
});

// ─── validateAllocation ───────────────────────────────────────────────────────

describe('validateAllocation', () => {
  const player = { resources: 2 };

  const valid = {
    east:     { crew: 1, resources: 1 },
    west:     { crew: 1, resources: 1 },
    downtown: { crew: 0, resources: 0 },
  };

  test('valid allocation returns null', () => {
    assert.equal(validateAllocation(valid, player), null);
  });

  test('crew-only (0 resources) is valid when player has none', () => {
    const alloc = {
      east:     { crew: 1, resources: 0 },
      west:     { crew: 1, resources: 0 },
      downtown: { crew: 0, resources: 0 },
    };
    assert.equal(validateAllocation(alloc, { resources: 0 }), null);
  });

  test('rejects null', () => {
    assert.ok(validateAllocation(null, player));
  });

  test('rejects wrong crew count (1 zone)', () => {
    const alloc = { east: { crew: 1, resources: 2 }, west: { crew: 0, resources: 0 }, downtown: { crew: 0, resources: 0 } };
    assert.equal(validateAllocation(alloc, player), 'Must assign crew to exactly 2 zones');
  });

  test('rejects wrong crew count (3 zones)', () => {
    const alloc = { east: { crew: 1, resources: 1 }, west: { crew: 1, resources: 1 }, downtown: { crew: 1, resources: 0 } };
    assert.equal(validateAllocation(alloc, { resources: 2 }), 'Must assign crew to exactly 2 zones');
  });

  test('rejects resources not matching player total', () => {
    const alloc = { east: { crew: 1, resources: 3 }, west: { crew: 1, resources: 0 }, downtown: { crew: 0, resources: 0 } };
    assert.equal(validateAllocation(alloc, player), 'Must allocate all your resources');
  });

  test('rejects resources without crew', () => {
    const alloc = { east: { crew: 1, resources: 2 }, west: { crew: 0, resources: 0 }, downtown: { crew: 0, resources: 0 } };
    // Only 1 crew — fails crew count check first
    assert.ok(validateAllocation(alloc, player));
  });

  test('rejects negative resources', () => {
    const alloc = { east: { crew: 1, resources: -1 }, west: { crew: 1, resources: 3 }, downtown: { crew: 0, resources: 0 } };
    assert.equal(validateAllocation(alloc, player), 'Invalid resources');
  });
});

// ─── determineWinners ─────────────────────────────────────────────────────────

describe('determineWinners', () => {
  test('most resources wins outright', () => {
    const players = [
      { name: 'Alice', resources: 5, heat: 2 },
      { name: 'Bob',   resources: 3, heat: 0 },
      { name: 'Carol', resources: 2, heat: 1 },
    ];
    assert.deepEqual(determineWinners(players), ['Alice']);
  });

  test('tie broken by least heat', () => {
    const players = [
      { name: 'Alice', resources: 4, heat: 2 },
      { name: 'Bob',   resources: 4, heat: 0 },
      { name: 'Carol', resources: 2, heat: 0 },
    ];
    assert.deepEqual(determineWinners(players), ['Bob']);
  });

  test('both win if fully tied', () => {
    const players = [
      { name: 'Alice', resources: 4, heat: 1 },
      { name: 'Bob',   resources: 4, heat: 1 },
    ];
    const winners = determineWinners(players);
    assert.equal(winners.length, 2);
    assert.ok(winners.includes('Alice'));
    assert.ok(winners.includes('Bob'));
  });

  test('third player excluded from tie when different heat', () => {
    const players = [
      { name: 'Alice', resources: 4, heat: 0 },
      { name: 'Bob',   resources: 4, heat: 1 },
      { name: 'Carol', resources: 4, heat: 0 },
    ];
    const winners = determineWinners(players);
    assert.equal(winners.length, 2);
    assert.ok(winners.includes('Alice'));
    assert.ok(winners.includes('Carol'));
    assert.ok(!winners.includes('Bob'));
  });
});
