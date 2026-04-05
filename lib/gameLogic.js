// Pure game logic — no I/O, no server state.
// Shared between server.js, p2p/peer-host.js, and tests.

const ZONES = ['east', 'west', 'downtown'];

// Canonical icon list — single source of truth for server, P2P host, and browser.
// (Browser also reads this from public/shared.js as a global — keep in sync.)
const PLAYER_ICONS = ['☯','★','♠','♣','♥','♦','⛬','▲'];

const ZONE_TURF = { west: 'docks', downtown: 'strip', east: 'slums' };

function aggregateZones(pendingAllocations) {
  const totals = { east: 0, west: 0, downtown: 0 };
  for (const alloc of pendingAllocations.values()) {
    for (const zone of ZONES) {
      totals[zone] += alloc[zone].crew + alloc[zone].resources;
    }
  }
  return totals;
}

function classifyZones(totals) {
  const vals = ZONES.map(z => totals[z]);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);

  if (unique.length === 3) {
    const roles = {};
    roles[ZONES.find(z => totals[z] === unique[0])] = 'lowest';
    roles[ZONES.find(z => totals[z] === unique[1])] = 'middle';
    roles[ZONES.find(z => totals[z] === unique[2])] = 'highest';
    return { outcome: 'all_different', roles };
  }

  if (unique.length === 1) {
    const roles = {};
    ZONES.forEach(z => roles[z] = 'tied');
    return { outcome: 'all_tied', roles };
  }

  // Two zones tied
  const tiedVal = unique.find(v => counts[v] === 2);
  const loneVal = unique.find(v => counts[v] === 1);
  const tiedZones = ZONES.filter(z => totals[z] === tiedVal);
  const loneZone = ZONES.find(z => totals[z] === loneVal);

  const roles = {};
  if (tiedVal < loneVal) {
    tiedZones.forEach(z => roles[z] = 'tied_lowest');
    roles[loneZone] = 'lone_highest';
    return { outcome: 'two_tied_lowest', roles };
  } else {
    tiedZones.forEach(z => roles[z] = 'tied_highest');
    roles[loneZone] = 'lone_lowest';
    return { outcome: 'two_tied_highest', roles };
  }
}

// Returns resource delta for a player's contribution to one zone.
// crew is always 1 when player is in the zone, res >= 0.
// Note: tied_highest with res=0 returns 0 — the crew penalty is applied
// separately in resolveRound after all zone deltas are summed.
function zoneDelta(crew, res, role, classificationOutcome, isHomeTurf = false) {
  let result;
  if (classificationOutcome === 'all_tied') {
    result = (crew + res >= 2) ? -1 : 0;
  } else {
    switch (role) {
      case 'highest':
      case 'lone_highest':
        result = -(res + 1); break;
      case 'middle':
        result = 1; break;
      case 'lowest':
      case 'lone_lowest':
        result = 2 * (crew + res); break;
      case 'tied_lowest':
        result = crew + res; break;
      case 'tied_highest':
        result = Math.floor((crew + res) / 2) - res; break;
      default:
        result = 0;
    }
  }
  return (isHomeTurf && result > 0) ? result + 1 : result;
}

function validateAllocation(alloc, player) {
  if (!alloc || typeof alloc !== 'object') return 'Invalid allocation';
  let crewCount = 0;
  let totalResources = 0;
  for (const zone of ZONES) {
    const z = alloc[zone];
    if (!z || typeof z !== 'object') return 'Invalid allocation format';
    const { crew, resources } = z;
    if (crew !== 0 && crew !== 1) return 'Invalid crew value';
    if (typeof resources !== 'number' || !Number.isInteger(resources) || resources < 0) return 'Invalid resources';
    if (resources > 0 && crew === 0) return 'Cannot place resources without crew';
    crewCount += crew;
    totalResources += resources;
  }
  if (crewCount !== 2) return 'Must assign crew to exactly 2 zones';
  if (totalResources !== player.resources) return 'Must allocate all your resources';
  return null;
}

function determineWinners(players) {
  const maxRes = Math.max(...players.map(p => p.resources));
  const contenders = players.filter(p => p.resources === maxRes);
  if (contenders.length === 1) return [contenders[0].name];
  const minHeat = Math.min(...contenders.map(p => p.heat));
  return contenders.filter(p => p.heat === minHeat).map(p => p.name);
}

module.exports = { ZONES, ZONE_TURF, PLAYER_ICONS, aggregateZones, classifyZones, zoneDelta, validateAllocation, determineWinners };
