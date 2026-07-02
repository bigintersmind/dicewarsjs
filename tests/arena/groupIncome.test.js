import { computeGroups, cutValueFor, myGainIfCaptured } from '../../src/arena/groupIncome.js';
import { findLargestConnectedGroup } from '../../src/engine/TurnManager.js';
import { createRng } from '../../src/engine/rng.js';

/**
 * Build a BotArea[] board from a compact spec: owners keyed by area id plus an
 * undirected edge list. Mirrors the BotArea shape createBotState emits.
 */
function board(owners, edges) {
  const neighbors = new Map(Object.keys(owners).map(id => [Number(id), []]));
  for (const [a, b] of edges) {
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  return Object.entries(owners).map(([id, owner]) => ({
    id: Number(id),
    owner,
    dice: 1,
    neighbors: neighbors.get(Number(id)),
    isBorder: neighbors
      .get(Number(id))
      .some(adjId => owners[adjId] !== undefined && owners[adjId] !== owner),
  }));
}

const byId = (areas, id) => areas.find(a => a.id === id);

describe('computeGroups', () => {
  it('labels a single area as one component of size 1', () => {
    const areas = board({ 1: 0 }, []);
    const groups = computeGroups(areas);
    expect(groups.compSizes).toEqual([1]);
    expect(groups.largestByOwner.get(0)).toBe(1);
  });

  it('joins a same-owner chain into one component', () => {
    const areas = board({ 1: 0, 2: 0, 3: 0 }, [
      [1, 2],
      [2, 3],
    ]);
    const groups = computeGroups(areas);
    expect(groups.largestByOwner.get(0)).toBe(3);
    const comp = groups.compIndexById.get(1);
    expect(groups.compIndexById.get(2)).toBe(comp);
    expect(groups.compIndexById.get(3)).toBe(comp);
  });

  it('splits components at ownership boundaries', () => {
    // 1(p0) - 2(p1) - 3(p0): the enemy in the middle keeps p0 split.
    const areas = board({ 1: 0, 2: 1, 3: 0 }, [
      [1, 2],
      [2, 3],
    ]);
    const groups = computeGroups(areas);
    expect(groups.largestByOwner.get(0)).toBe(1);
    expect(groups.largestByOwner.get(1)).toBe(1);
    expect(groups.compIndexById.get(1)).not.toBe(groups.compIndexById.get(3));
  });

  it('tracks the largest of multiple disjoint components per owner', () => {
    const areas = board({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1 }, [
      [1, 2],
      [2, 3], // comp of 3
      [4, 5], // comp of 2
      [3, 6],
      [6, 4], // enemy bridge between them
    ]);
    const groups = computeGroups(areas);
    expect(groups.largestByOwner.get(0)).toBe(3);
    expect(groups.largestByOwner.get(1)).toBe(1);
    expect([...groups.compSizes].sort()).toEqual([1, 2, 3]);
  });

  it('ignores neighbor ids absent from allAreas', () => {
    const areas = board({ 1: 0, 2: 0 }, [[1, 2]]);
    areas[0].neighbors.push(99); // dangling reference
    const groups = computeGroups(areas);
    expect(groups.largestByOwner.get(0)).toBe(2);
  });
});

describe('cutValueFor', () => {
  it('is the full split cost for the bridge of a chain', () => {
    // 1 - 2 - 3 all owner 0: cutting the middle leaves two singletons.
    const areas = board({ 1: 0, 2: 0, 3: 0 }, [
      [1, 2],
      [2, 3],
    ]);
    const groups = computeGroups(areas);
    expect(cutValueFor(byId(areas, 2), groups)).toBe(2); // 3 → 1
    expect(cutValueFor(byId(areas, 1), groups)).toBe(1); // 3 → 2 (endpoint)
  });

  it('is 0 for a node outside the owner largest component', () => {
    const areas = board({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, [
      [1, 2],
      [2, 3], // largest comp (3)
      [4, 5], // singleton comp for p0 at 4
    ]);
    const groups = computeGroups(areas);
    expect(cutValueFor(byId(areas, 4), groups)).toBe(0);
  });

  it('is 0 when a tied largest component survives intact', () => {
    // Two p0 components of size 2 each; cutting a node from one leaves the other.
    const areas = board({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 }, [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    const groups = computeGroups(areas);
    expect(groups.largestByOwner.get(0)).toBe(2);
    expect(cutValueFor(byId(areas, 1), groups)).toBe(0);
  });
});

describe('myGainIfCaptured', () => {
  it('counts the merge of all my adjacent components plus the captured node', () => {
    // p0 comps {1,2} and {4,5} both adjacent to enemy 3: capture merges 2+2+1.
    const areas = board({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 }, [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    const groups = computeGroups(areas);
    expect(myGainIfCaptured(byId(areas, 3), groups, 0)).toBe(3); // 5 - 2
  });

  it('is the simple extension delta when only one component touches the target', () => {
    const areas = board({ 1: 0, 2: 0, 3: 1 }, [
      [1, 2],
      [2, 3],
    ]);
    const groups = computeGroups(areas);
    expect(myGainIfCaptured(byId(areas, 3), groups, 0)).toBe(1); // 3 - 2
  });

  it('is 0 for a capture that cannot grow my largest group', () => {
    // My largest is 3 elsewhere; capturing an isolated enemy yields a group of 1.
    const areas = board({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 }, [
      [1, 2],
      [2, 3],
      [4, 5],
    ]);
    const groups = computeGroups(areas);
    expect(myGainIfCaptured(byId(areas, 5), groups, 0)).toBe(0); // merged 1 < largest 3
  });

  it('is 0 for an area I already own', () => {
    const areas = board({ 1: 0, 2: 0 }, [[1, 2]]);
    const groups = computeGroups(areas);
    expect(myGainIfCaptured(byId(areas, 1), groups, 0)).toBe(0);
  });
});

describe('fuzz cross-check vs engine findLargestConnectedGroup', () => {
  /**
   * Random engine-format board: `size > 0` areas with symmetric
   * neighborAreaIds, random owners. Index 0 is the unused sentinel,
   * matching the engine Area[] convention.
   */
  function randomEngineBoard(rng, areaCount, playerCount) {
    const areas = [{ size: 0, owner: -1, neighborAreaIds: [] }];
    for (let id = 1; id <= areaCount; id++) {
      areas.push({
        id,
        size: 1,
        owner: rng.nextInt(0, playerCount - 1),
        neighborAreaIds: [],
      });
    }
    // Random spanning chain + extra random edges → connected-ish, varied shapes.
    for (let id = 2; id <= areaCount; id++) {
      const other = rng.nextInt(1, id - 1);
      areas[id].neighborAreaIds.push(other);
      areas[other].neighborAreaIds.push(id);
    }
    const extraEdges = rng.nextInt(0, areaCount - 1);
    for (let e = 0; e < extraEdges; e++) {
      const a = rng.nextInt(1, areaCount);
      const b = rng.nextInt(1, areaCount);
      if (a !== b && !areas[a].neighborAreaIds.includes(b)) {
        areas[a].neighborAreaIds.push(b);
        areas[b].neighborAreaIds.push(a);
      }
    }
    return areas;
  }

  /** Engine Area[] → the BotArea[] shape createBotState emits. */
  function toBotAreas(engineAreas) {
    return engineAreas
      .filter(a => a.size > 0)
      .map(a => ({
        id: a.id,
        owner: a.owner,
        dice: 1,
        neighbors: [...a.neighborAreaIds],
        isBorder: a.neighborAreaIds.some(adjId => engineAreas[adjId].owner !== a.owner),
      }));
  }

  it('largestByOwner matches the engine income function on random boards', () => {
    const rng = createRng(1234);
    for (let round = 0; round < 25; round++) {
      const playerCount = rng.nextInt(2, 5);
      const engineAreas = randomEngineBoard(rng, rng.nextInt(8, 31), playerCount);
      const groups = computeGroups(toBotAreas(engineAreas));
      for (let p = 0; p < playerCount; p++) {
        expect(groups.largestByOwner.get(p) ?? 0).toBe(findLargestConnectedGroup(engineAreas, p));
      }
    }
  });

  it('capture deltas match a simulated ownership flip on random boards', () => {
    /*
     * The definitional property of both helpers: flip one enemy area to `me`
     * and recompute income with the engine function. Then
     *   myGainIfCaptured === largest(me, flipped)    − largest(me, original)
     *   cutValueFor      === largest(owner, original) − largest(owner, flipped)
     */
    const rng = createRng(5678);
    for (let round = 0; round < 25; round++) {
      const playerCount = rng.nextInt(2, 5);
      const engineAreas = randomEngineBoard(rng, rng.nextInt(8, 31), playerCount);
      const botAreas = toBotAreas(engineAreas);
      const groups = computeGroups(botAreas);
      const me = rng.nextInt(0, playerCount - 1);

      for (const area of botAreas) {
        if (area.owner === me) continue;
        const flipped = engineAreas.map(a => (a.id === area.id ? { ...a, owner: me } : a));
        const gain =
          findLargestConnectedGroup(flipped, me) - findLargestConnectedGroup(engineAreas, me);
        const loss =
          findLargestConnectedGroup(engineAreas, area.owner) -
          findLargestConnectedGroup(flipped, area.owner);
        expect(myGainIfCaptured(area, groups, me)).toBe(gain);
        expect(cutValueFor(area, groups)).toBe(loss);
      }
    }
  });
});
