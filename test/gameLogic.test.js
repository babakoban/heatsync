const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateZones, classifyZones, zoneDelta, validateAllocation, determineWinners, PLAYER_ICONS, ZONES } = require('../lib/gameLogic');

// ─── aggregateZones ────────────────────────────────────────────────────────────

describe('aggregateZones', () => {
  test('sums crew + resources across all players per zone', () => {
    const allocs = new Map([
      ['Alice', { docks: { crew: 1, resources: 2 }, strip: { crew: 1, resources: 0 }, slums: { crew: 0, resources: 0 } }],
      ['Bob',   { docks: { crew: 0, resources: 0 }, strip: { crew: 1, resources: 1 }, slums: { crew: 1, resources: 3 } }],
    ]);
    const totals = aggregateZones(allocs);
    assert.deepEqual(totals, { docks: 3, strip: 3, slums: 4 });
  });

  test('returns zeros for empty allocations', () => {
    assert.deepEqual(aggregateZones(new Map()), { docks: 0, strip: 0, slums: 0 });
  });
});

// ─── classifyZones ────────────────────────────────────────────────────────────

describe('classifyZones', () => {
  test('all different — assigns lowest/middle/highest correctly', () => {
    const result = classifyZones({ docks: 1, strip: 3, slums: 5 });
    assert.equal(result.outcome, 'all_different');
    assert.equal(result.roles.docks, 'lowest');
    assert.equal(result.roles.strip, 'middle');
    assert.equal(result.roles.slums, 'highest');
  });

  test('all tied', () => {
    const result = classifyZones({ docks: 4, strip: 4, slums: 4 });
    assert.equal(result.outcome, 'all_tied');
    assert.equal(result.roles.docks, 'tied');
    assert.equal(result.roles.strip, 'tied');
    assert.equal(result.roles.slums, 'tied');
  });

  test('two tied for lowest', () => {
    const result = classifyZones({ docks: 2, strip: 2, slums: 6 });
    assert.equal(result.outcome, 'two_tied_lowest');
    assert.equal(result.roles.docks, 'tied_lowest');
    assert.equal(result.roles.strip, 'tied_lowest');
    assert.equal(result.roles.slums, 'lone_highest');
  });

  test('two tied for highest', () => {
    const result = classifyZones({ docks: 5, strip: 5, slums: 1 });
    assert.equal(result.outcome, 'two_tied_highest');
    assert.equal(result.roles.docks, 'tied_highest');
    assert.equal(result.roles.strip, 'tied_highest');
    assert.equal(result.roles.slums, 'lone_lowest');
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

  test('lowest: gain = 2 × placement (triple means end = 3P, gain = 2P)', () => {
    assert.equal(zoneDelta(1, 0, 'lowest', 'all_different'), 2);  // 2×1 = 2
    assert.equal(zoneDelta(1, 2, 'lowest', 'all_different'), 6);  // 2×3 = 6
  });

  test('lone_lowest behaves like lowest', () => {
    assert.equal(zoneDelta(1, 1, 'lone_lowest', 'two_tied_highest'), 4);  // 2×2 = 4
  });

  test('tied_lowest: gain = placement (double means end = 2P, gain = P)', () => {
    assert.equal(zoneDelta(1, 0, 'tied_lowest', 'two_tied_lowest'), 1);  // 1×1 = 1
    assert.equal(zoneDelta(1, 3, 'tied_lowest', 'two_tied_lowest'), 4);  // 1×4 = 4
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

  test('home turf bonus: adds +1 to positive gains', () => {
    // lowest gains 2*(1+0)=2, home turf makes it 3
    assert.equal(zoneDelta(1, 0, 'lowest', 'all_different', true), 3);
    // middle gains 1, home turf makes it 2
    assert.equal(zoneDelta(1, 0, 'middle', 'all_different', true), 2);
    // tied_lowest gains 1+0=1, home turf makes it 2
    assert.equal(zoneDelta(1, 0, 'tied_lowest', 'two_tied_lowest', true), 2);
  });

  test('home turf bonus: no bonus on negative or zero results', () => {
    // highest loses -(0+1)=-1, no bonus
    assert.equal(zoneDelta(1, 0, 'highest', 'all_different', true), -1);
    // tied_highest crew-only returns 0, no bonus
    assert.equal(zoneDelta(1, 0, 'tied_highest', 'two_tied_highest', true), 0);
    // all_tied crew-only returns 0, no bonus
    assert.equal(zoneDelta(1, 0, 'tied', 'all_tied', true), 0);
  });

  test('home turf bonus: isHomeTurf=false behaves identically to default', () => {
    assert.equal(zoneDelta(1, 0, 'lowest', 'all_different', false), zoneDelta(1, 0, 'lowest', 'all_different'));
    assert.equal(zoneDelta(1, 2, 'highest', 'all_different', false), zoneDelta(1, 2, 'highest', 'all_different'));
  });

  // Crew recovery cost: zoneDelta returns 0 for tied_highest crew-only.
  // The server then subtracts an additional 1 Ⓡ (crewPenalty) after applying all deltas.
  // These tests document the boundary values to catch formula regressions.
  test('tied_highest res=1: floor(2/2)-1 = 0 — break-even, no net gain', () => {
    assert.equal(zoneDelta(1, 1, 'tied_highest', 'two_tied_highest'), 0);
  });

  test('tied_highest res=3: floor(4/2)-3 = -1', () => {
    assert.equal(zoneDelta(1, 3, 'tied_highest', 'two_tied_highest'), -1);
  });
});

// ─── validateAllocation ───────────────────────────────────────────────────────

describe('validateAllocation', () => {
  const player = { resources: 2 };

  const valid = {
    docks: { crew: 1, resources: 1 },
    strip: { crew: 1, resources: 1 },
    slums: { crew: 0, resources: 0 },
  };

  test('valid allocation returns null', () => {
    assert.equal(validateAllocation(valid, player), null);
  });

  test('crew-only (0 resources) is valid when player has none', () => {
    const alloc = {
      docks: { crew: 1, resources: 0 },
      strip: { crew: 1, resources: 0 },
      slums: { crew: 0, resources: 0 },
    };
    assert.equal(validateAllocation(alloc, { resources: 0 }), null);
  });

  test('rejects null', () => {
    assert.ok(validateAllocation(null, player));
  });

  test('rejects wrong crew count (1 zone)', () => {
    const alloc = { docks: { crew: 1, resources: 2 }, strip: { crew: 0, resources: 0 }, slums: { crew: 0, resources: 0 } };
    assert.equal(validateAllocation(alloc, player), 'Must assign crew to exactly 2 zones');
  });

  test('rejects wrong crew count (3 zones)', () => {
    const alloc = { docks: { crew: 1, resources: 1 }, strip: { crew: 1, resources: 1 }, slums: { crew: 1, resources: 0 } };
    assert.equal(validateAllocation(alloc, { resources: 2 }), 'Must assign crew to exactly 2 zones');
  });

  test('rejects resources not matching player total', () => {
    const alloc = { docks: { crew: 1, resources: 3 }, strip: { crew: 1, resources: 0 }, slums: { crew: 0, resources: 0 } };
    assert.equal(validateAllocation(alloc, player), 'Must allocate all your resources');
  });

  test('rejects resources without crew', () => {
    const alloc = { docks: { crew: 1, resources: 2 }, strip: { crew: 0, resources: 0 }, slums: { crew: 0, resources: 0 } };
    // Only 1 crew — fails crew count check first
    assert.ok(validateAllocation(alloc, player));
  });

  test('rejects negative resources', () => {
    const alloc = { docks: { crew: 1, resources: -1 }, strip: { crew: 1, resources: 3 }, slums: { crew: 0, resources: 0 } };
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

  // Heat penalty scenario: a player who hit 0 resources during an earlier round
  // receives +1 heat. This test confirms that the extra heat correctly breaks ties.
  test('heat penalty recipient loses tiebreaker to clean player', () => {
    const players = [
      { name: 'Alice', resources: 3, heat: 1 }, // gained heat from hitting 0 in round 1
      { name: 'Bob',   resources: 3, heat: 0 }, // never hit 0
    ];
    assert.deepEqual(determineWinners(players), ['Bob']);
  });

  test('player with zero resources is still eligible to win if opponent also has zero', () => {
    const players = [
      { name: 'Alice', resources: 0, heat: 2 },
      { name: 'Bob',   resources: 0, heat: 2 },
    ];
    const winners = determineWinners(players);
    assert.equal(winners.length, 2);
    assert.ok(winners.includes('Alice') && winners.includes('Bob'));
  });
});

// ─── aggregateZones (additional) ─────────────────────────────────────────────

describe('aggregateZones (additional)', () => {
  test('single player — crew and resources counted separately', () => {
    const allocs = new Map([
      ['Alice', { docks: { crew: 1, resources: 3 }, strip: { crew: 1, resources: 0 }, slums: { crew: 0, resources: 0 } }],
    ]);
    assert.deepEqual(aggregateZones(allocs), { docks: 4, strip: 1, slums: 0 });
  });

  test('three players with different zone combos', () => {
    const allocs = new Map([
      ['A', { docks: { crew: 1, resources: 2 }, strip: { crew: 0, resources: 0 }, slums: { crew: 1, resources: 1 } }],
      ['B', { docks: { crew: 0, resources: 0 }, strip: { crew: 1, resources: 3 }, slums: { crew: 1, resources: 0 } }],
      ['C', { docks: { crew: 1, resources: 1 }, strip: { crew: 1, resources: 2 }, slums: { crew: 0, resources: 0 } }],
    ]);
    const totals = aggregateZones(allocs);
    assert.equal(totals.docks, 5);  // A:(1+2)=3, C:(1+1)=2 → 5
    assert.equal(totals.strip, 7);  // B:(1+3)=4, C:(1+2)=3 → 7
    assert.equal(totals.slums, 3);  // A:(1+1)=2, B:(1+0)=1 → 3
  });

  test('all crew-only allocations yield 1 per zone per player', () => {
    const allocs = new Map([
      ['A', { docks: { crew: 1, resources: 0 }, strip: { crew: 1, resources: 0 }, slums: { crew: 0, resources: 0 } }],
      ['B', { docks: { crew: 0, resources: 0 }, strip: { crew: 1, resources: 0 }, slums: { crew: 1, resources: 0 } }],
    ]);
    const totals = aggregateZones(allocs);
    assert.equal(totals.docks, 1);
    assert.equal(totals.strip, 2);
    assert.equal(totals.slums, 1);
  });

  test('six players all stacking same zone', () => {
    const allocs = new Map(
      ['A','B','C','D','E','F'].map(n => [
        n,
        { docks: { crew: 1, resources: 2 }, strip: { crew: 1, resources: 0 }, slums: { crew: 0, resources: 0 } },
      ])
    );
    const totals = aggregateZones(allocs);
    assert.equal(totals.docks, 18); // 6 × (1+2)
    assert.equal(totals.strip, 6);  // 6 × 1
    assert.equal(totals.slums, 0);
  });
});

// ─── classifyZones (additional) ──────────────────────────────────────────────

describe('classifyZones (additional)', () => {
  test('all zeros → all_tied', () => {
    const result = classifyZones({ docks: 0, strip: 0, slums: 0 });
    assert.equal(result.outcome, 'all_tied');
    assert.ok(Object.values(result.roles).every(r => r === 'tied'));
  });

  test('two tied for highest with large values', () => {
    const result = classifyZones({ docks: 10, strip: 10, slums: 1 });
    assert.equal(result.outcome, 'two_tied_highest');
    assert.equal(result.roles.docks, 'tied_highest');
    assert.equal(result.roles.strip, 'tied_highest');
    assert.equal(result.roles.slums, 'lone_lowest');
  });

  test('two tied for lowest with zero', () => {
    const result = classifyZones({ docks: 0, strip: 0, slums: 5 });
    assert.equal(result.outcome, 'two_tied_lowest');
    assert.equal(result.roles.docks, 'tied_lowest');
    assert.equal(result.roles.strip, 'tied_lowest');
    assert.equal(result.roles.slums, 'lone_highest');
  });

  test('all_different with reversed ordering', () => {
    const result = classifyZones({ docks: 9, strip: 1, slums: 5 });
    assert.equal(result.outcome, 'all_different');
    assert.equal(result.roles.strip, 'lowest');
    assert.equal(result.roles.slums, 'middle');
    assert.equal(result.roles.docks, 'highest');
  });

  test('slums is the lone zone regardless of which two tie', () => {
    // docks and slums tie for lowest, strip is highest
    const result = classifyZones({ docks: 2, strip: 8, slums: 2 });
    assert.equal(result.outcome, 'two_tied_lowest');
    assert.equal(result.roles.docks, 'tied_lowest');
    assert.equal(result.roles.slums, 'tied_lowest');
    assert.equal(result.roles.strip, 'lone_highest');
  });
});

// ─── zoneDelta (additional) ───────────────────────────────────────────────────

describe('zoneDelta (additional)', () => {
  test('lone_highest with high resources — same formula as highest', () => {
    assert.equal(zoneDelta(1, 5, 'lone_highest', 'two_tied_lowest'), -(5 + 1));
  });

  test('lone_lowest with resources — same formula as lowest', () => {
    assert.equal(zoneDelta(1, 2, 'lone_lowest', 'two_tied_highest'), 2 * (1 + 2));
  });

  test('all_tied crew=1 res=0 is safe (total = 1 < 2)', () => {
    assert.equal(zoneDelta(1, 0, 'tied', 'all_tied'), 0);
  });

  test('all_tied crew=1 res=1 is crackdown (total = 2)', () => {
    assert.equal(zoneDelta(1, 1, 'tied', 'all_tied'), -1);
  });

  test('all_tied crew=1 res=5 is still -1 crackdown (not scaled)', () => {
    assert.equal(zoneDelta(1, 5, 'tied', 'all_tied'), -1);
  });

  test('home turf bonus on tied_lowest', () => {
    // (1+2) + 1 turf bonus = 4
    assert.equal(zoneDelta(1, 2, 'tied_lowest', 'two_tied_lowest', true), 4);
  });

  test('home turf bonus on lone_lowest', () => {
    // 2*(1+1) + 1 = 5
    assert.equal(zoneDelta(1, 1, 'lone_lowest', 'two_tied_highest', true), 5);
  });

  test('home turf bonus does NOT apply to crackdown (negative result)', () => {
    assert.equal(zoneDelta(1, 1, 'tied', 'all_tied', true), -1);
  });

  test('home turf bonus does NOT apply when result is exactly zero', () => {
    assert.equal(zoneDelta(1, 0, 'tied_highest', 'two_tied_highest', true), 0);
    assert.equal(zoneDelta(1, 0, 'tied', 'all_tied', true), 0);
  });

  test('tied_highest formula: floor((1+res)/2) - res', () => {
    // res=0: floor(1/2)=0 → 0
    // res=1: floor(2/2)-1=0 → 0
    // res=2: floor(3/2)-2=-1
    // res=5: floor(6/2)-5=-2
    assert.equal(zoneDelta(1, 0, 'tied_highest', 'two_tied_highest'), 0);
    assert.equal(zoneDelta(1, 1, 'tied_highest', 'two_tied_highest'), 0);
    assert.equal(zoneDelta(1, 2, 'tied_highest', 'two_tied_highest'), -1);
    assert.equal(zoneDelta(1, 5, 'tied_highest', 'two_tied_highest'), -2);
  });
});

// ─── validateAllocation (additional) ─────────────────────────────────────────

describe('validateAllocation (additional)', () => {
  test('rejects non-object types', () => {
    assert.ok(validateAllocation('string', { resources: 0 }));
    assert.ok(validateAllocation(42, { resources: 0 }));
    assert.ok(validateAllocation(null, { resources: 1 }));
  });

  test('rejects missing zone key', () => {
    // slums missing
    const alloc = { docks: { crew: 1, resources: 0 }, strip: { crew: 1, resources: 0 } };
    assert.ok(validateAllocation(alloc, { resources: 0 }));
  });

  test('rejects resources placed in zone without crew', () => {
    const alloc = {
      docks: { crew: 1, resources: 1 },
      strip: { crew: 1, resources: 0 },
      slums: { crew: 0, resources: 1 }, // resources but no crew!
    };
    assert.equal(validateAllocation(alloc, { resources: 2 }), 'Cannot place resources without crew');
  });

  test('accepts max resources split across two zones', () => {
    const alloc = {
      docks: { crew: 1, resources: 8 },
      strip: { crew: 1, resources: 2 },
      slums: { crew: 0, resources: 0 },
    };
    assert.equal(validateAllocation(alloc, { resources: 10 }), null);
  });

  test('rejects crew value of 2 (must be 0 or 1)', () => {
    const alloc = {
      docks: { crew: 2, resources: 0 },
      strip: { crew: 0, resources: 0 },
      slums: { crew: 0, resources: 0 },
    };
    assert.ok(validateAllocation(alloc, { resources: 0 }));
  });

  test('rejects fractional resources', () => {
    const alloc = {
      docks: { crew: 1, resources: 0.5 },
      strip: { crew: 1, resources: 0.5 },
      slums: { crew: 0, resources: 0 },
    };
    assert.ok(validateAllocation(alloc, { resources: 1 }));
  });

  test('rejects submitting more resources than player has', () => {
    const alloc = {
      docks: { crew: 1, resources: 5 },
      strip: { crew: 1, resources: 0 },
      slums: { crew: 0, resources: 0 },
    };
    assert.equal(validateAllocation(alloc, { resources: 3 }), 'Must allocate all your resources');
  });
});

// ─── determineWinners (additional) ───────────────────────────────────────────

describe('determineWinners (additional)', () => {
  test('single player always wins regardless of heat', () => {
    assert.deepEqual(determineWinners([{ name: 'Solo', resources: 0, heat: 99 }]), ['Solo']);
  });

  test('all six players tied on resources and heat — all win', () => {
    const players = ['A','B','C','D','E','F'].map(n => ({ name: n, resources: 3, heat: 1 }));
    const winners = determineWinners(players);
    assert.equal(winners.length, 6);
    for (const p of players) assert.ok(winners.includes(p.name));
  });

  test('resource leader wins even with high heat', () => {
    const players = [
      { name: 'A', resources: 10, heat: 5 },
      { name: 'B', resources: 9,  heat: 0 },
      { name: 'C', resources: 9,  heat: 0 },
    ];
    assert.deepEqual(determineWinners(players), ['A']);
  });

  test('three-way tie on resources; two share minimum heat', () => {
    const players = [
      { name: 'A', resources: 5, heat: 0 },
      { name: 'B', resources: 5, heat: 1 },
      { name: 'C', resources: 5, heat: 0 },
      { name: 'D', resources: 3, heat: 0 },
    ];
    const winners = determineWinners(players);
    assert.equal(winners.length, 2);
    assert.ok(winners.includes('A'));
    assert.ok(winners.includes('C'));
    assert.ok(!winners.includes('B'));
    assert.ok(!winners.includes('D'));
  });

  test('winner with zero resources beats player with negative would-be resources', () => {
    // Resources are clamped to 0 by the server, so minimum is 0
    const players = [
      { name: 'A', resources: 0, heat: 0 },
      { name: 'B', resources: 0, heat: 1 },
    ];
    assert.deepEqual(determineWinners(players), ['A']);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('PLAYER_ICONS constant', () => {
  test('contains exactly 8 icons', () => {
    assert.equal(PLAYER_ICONS.length, 8);
  });

  test('all icons are unique', () => {
    assert.equal(new Set(PLAYER_ICONS).size, PLAYER_ICONS.length);
  });
});

describe('ZONES constant', () => {
  test('contains docks, strip, and slums', () => {
    assert.deepEqual([...ZONES].sort(), ['docks', 'slums', 'strip']);
  });
});

// ─── crewRecoveryCostEnabled ──────────────────────────────────────────────────

describe('zoneDelta crewRecoveryCostEnabled=false', () => {
  test('highest crew-only: returns 0 (no recovery cost)', () => {
    assert.equal(zoneDelta(1, 0, 'highest', 'all_different', false, false), 0);
  });

  test('highest with resources: returns -res only (no +1 crew cost)', () => {
    assert.equal(zoneDelta(1, 2, 'highest', 'all_different', false, false), -2);
    assert.equal(zoneDelta(1, 3, 'highest', 'all_different', false, false), -3);
  });

  test('lone_highest crew-only: returns 0', () => {
    assert.equal(zoneDelta(1, 0, 'lone_highest', 'two_tied_lowest', false, false), 0);
  });

  test('lone_highest with resources: returns -res', () => {
    assert.equal(zoneDelta(1, 4, 'lone_highest', 'two_tied_lowest', false, false), -4);
  });

  test('crewRecoveryCostEnabled=true (default) still charges +1', () => {
    assert.equal(zoneDelta(1, 0, 'highest', 'all_different', false, true), -1);
    assert.equal(zoneDelta(1, 2, 'highest', 'all_different', false, true), -3);
  });

  test('other roles unaffected by crewRecoveryCostEnabled', () => {
    // middle, lowest, tied_lowest, tied_highest should be the same regardless
    assert.equal(zoneDelta(1, 0, 'middle',      'all_different',  false, false), 1);
    assert.equal(zoneDelta(1, 2, 'lowest',      'all_different',  false, false), 6);
    assert.equal(zoneDelta(1, 3, 'tied_lowest', 'two_tied_lowest',false, false), 4);
  });
});
