// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works, in brief:
//   1. Parse the level (XSB) into walls, goals, boxes and the player.
//   2. Split the board into rooms. A box pushed out of a room into the
//      hallway can never come back, so rooms are independent: the level's
//      optimum is the sum of the rooms' optima. The split is found by
//      cutting the hallway row's dead squares (squares from which no
//      backward pull from a goal can reach) and taking the connected
//      components that still hold boxes.
//   3. Solve each room on its own with A* over pushes. A state is the
//      sorted box squares plus the lowest square of the player's reachable
//      region; a step is one push. The estimate is the cheapest assignment
//      of boxes to goals by Manhattan distance, which never overestimates
//      the pushes left, so the first solution found is push-optimal.
//      Deadlocks are pruned: squares no box can be pulled from to a goal,
//      and frozen 2x2 blocks of walls and boxes.
//   4. If A* runs out of its node budget, the same search is retried
//      without the estimate (uniform-cost over pushes). If that also
//      gives up, the instance still gets a valid (empty) answer file.
//   5. Rooms are chained in order: the other rooms' boxes stand as walls
//      (on their goals once solved) and the player walks on from where
//      the last room left it, through the hallway.
//   6. The player's walk between pushes is a plain shortest-path search
//      over floor squares, boxes as obstacles.
//
// Determinism: every budget is counted in states, never in wall-clock
// time; direction order is fixed (up, down, left, right); ties in the
// search are broken by insertion order. The program reads no clock,
// no randomness and no environment value as a source of variation.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Search budgets, counted in states. A room the generator keeps is
// solvable by plain push search inside 250,000 states, so 600,000 with
// a guiding estimate leaves a wide margin.
const ASTAR_BUDGET = 600_000;
const BFS_BUDGET = 250_000;

// The four moves in one fixed order: up, down, left, right.
const DIRS = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

/** A board: width, height, walls (1 = wall), goals, boxes (sorted), player. */
function parseBoard(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever the text shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can stand on and still be pushed onto some goal,
 * found by pulling boxes backwards from the goals over open floor.
 * A box on any other square is dead: no push sequence saves it.
 */
function liveSquares(board) {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from` with `occupied`
 * in the way; marks them in `seen` with `stamp` and returns the lowest
 * square of the region, which names the region.
 */
function regionLow(board, occupied, from, seen, stamp, stack) {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes with a box among them off its goal. Such a
 * block never moves again, so the state is dead.
 */
function frozenBlock(board, occupied, goalSet, t) {
  const { w, wall } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) ||
        (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
  }
  return false;
}

// All orderings of n items, in lexicographic order, for the assignment estimate.
function allPermutations(n) {
  const out = [];
  const used = new Array(n).fill(false);
  const cur = [];
  const build = () => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      build();
      cur.pop();
      used[i] = false;
    }
  };
  build();
  return out;
}
const PERMS = { 1: [[0]], 2: allPermutations(2), 3: allPermutations(3), 4: allPermutations(4) };

/**
 * The cheapest assignment of boxes to goals by Manhattan distance.
 * One push moves one box by one square, so the true pushes left are
 * never below this sum: the estimate is admissible.
 */
function assignmentEstimate(boxes, goals, w) {
  const n = boxes.length;
  if (n === 0) return 0;
  // Manhattan distance from each box to each goal.
  const dist = [];
  for (let i = 0; i < n; i++) {
    const bx = boxes[i] % w;
    const by = (boxes[i] / w) | 0;
    const row = [];
    for (let j = 0; j < n; j++) {
      row.push(Math.abs((goals[j] % w) - bx) + Math.abs(((goals[j] / w) | 0) - by));
    }
    dist.push(row);
  }
  let best = Infinity;
  for (const perm of PERMS[n] ?? allPermutations(n)) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += dist[i][perm[i]];
    if (sum < best) best = sum;
  }
  return best;
}

// A state's key: the region's lowest square followed by the sorted box
// squares. Small states pack into one exact number (base `size`); large
// ones fall back to a string key, which is exact at any size.
function stateKey(boxes, low, size) {
  if (boxes.length <= 4 && size ** (boxes.length + 1) < 2 ** 53) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}|${boxes.join(',')}`;
}
function decodeBoxes(key, count, size) {
  if (typeof key === 'number') {
    const boxes = new Array(count);
    let k = key;
    for (let i = count - 1; i >= 0; i--) {
      boxes[i] = k % size;
      k = Math.floor(k / size);
    }
    return boxes;
  }
  return key.slice(key.indexOf('|') + 1).split(',').map(Number);
}

// A binary heap ordered by (f, -g, insertion order): lowest estimated
// total first, deeper states first on ties, then oldest first.
class OpenHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  static less(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  }
  push(entry) {
    const items = this.items;
    let i = items.length;
    items.push(entry);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!OpenHeap.less(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= items.length) break;
        if (c + 1 < items.length && OpenHeap.less(items[c + 1], items[c])) c++;
        if (!OpenHeap.less(items[c], items[i])) break;
        [items[i], items[c]] = [items[c], items[i]];
        i = c;
      }
    }
    return top;
  }
}

/**
 * Solve one board (a room, or a whole level) by search over pushes.
 * With `guided` the assignment estimate orders the search (A*); without
 * it the search is uniform-cost over pushes. Returns {pushes, moves} or
 * null when the state budget runs out or the board has no solution.
 */
function pushSearch(board, maxStates, guided) {
  const { w, wall, goals } = board;
  const size = wall.length;
  const n = board.boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(board);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let markStamp = 0;

  const solved = (boxes) => boxes.every((b) => goalSet[b]);
  if (board.boxes.some((b) => !live[b])) return null;

  // The states, in discovery order: key, parent id, g (pushes), and the
  // push (from-square, to-square) that made the state from its parent.
  const keys = [];
  const parents = [];
  const fromSq = [];
  const toSq = [];
  const gScore = [];
  const index = new Map();
  const addState = (key, parent, from, to, g) => {
    const id = keys.length;
    keys.push(key);
    parents.push(parent);
    fromSq.push(from);
    toSq.push(to);
    gScore.push(g);
    index.set(key, id);
    return id;
  };

  for (const b of board.boxes) occupied[b] = 1;
  const startLow = regionLow(board, occupied, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) occupied[b] = 0;
  const startKey = stateKey(board.boxes, startLow, size);
  addState(startKey, -1, -1, -1, 0);
  const heap = new OpenHeap();
  let seq = 0;
  const startH = guided ? assignmentEstimate(board.boxes, goals, w) : 0;
  heap.push([startH, 0, seq++, 0]);
  let found = solved(board.boxes) ? 0 : -1;

  while (heap.size > 0 && found < 0) {
    const [f, negG, , id] = heap.pop();
    if (gScore[id] !== -negG) continue; // superseded entry
    const g = gScore[id];
    const boxes = decodeBoxes(keys[id], n, size);
    const playerSq = id === 0 ? board.player : fromSq[id];
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(board, occupied, playerSq, seen, here, stack);
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = boxes[bi];
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const stand = b - d;
        const t = b + d;
        if (seen[stand] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(board, occupied, goalSet, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        // The child's region is flood-filled on a separate mark array:
        // it must not overwrite the parent region's marks, which the
        // remaining pushes of this expansion still consult.
        const low = regionLow(board, occupied, b, mark, ++markStamp, stack);
        const key = stateKey(next, low, size);
        occupied[t] = 0;
        occupied[b] = 1;
        const prev = index.get(key);
        if (prev !== undefined && gScore[prev] <= g + 1) continue;
        if (keys.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        let nid;
        if (prev !== undefined) {
          // A better route to a known state: keep its id, refresh the path.
          nid = prev;
          parents[nid] = id;
          fromSq[nid] = b;
          toSq[nid] = t;
          gScore[nid] = g + 1;
          keys[nid] = key;
        } else {
          nid = addState(key, id, b, t, g + 1);
        }
        if (solved(next)) {
          found = nid;
          break;
        }
        const h = guided ? assignmentEstimate(next, goals, w) : 0;
        heap.push([g + 1 + h, -(g + 1), seq++, nid]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push chain, then turn it into walks plus pushes.
  const chain = [];
  for (let s = found; s > 0; s = parents[s]) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of chain) {
    const from = fromSq[s];
    const to = toSq[s];
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * w + dd.dx === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkPath(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    const at = boxes.indexOf(from);
    boxes[at] = to;
    boxes.sort((a, b2) => a - b2);
  }
  return { pushes: chain.length, moves };
}

/**
 * The shortest walk from `from` to `to` over floor squares, boxes as
 * obstacles, in lower-case letters. Direction order is fixed, so ties
 * resolve the same way on every run.
 */
function walkPath(board, occupied, from, to) {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after following `moves` from `from`. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    p += ch === 'u' || ch === 'U' ? -w : ch === 'd' || ch === 'D' ? w : ch === 'l' || ch === 'L' ? -1 : 1;
  }
  return p;
}

/**
 * Split the level into rooms: cut the hallway row's dead squares out of
 * the floor, and each connected part left that holds a box is a room.
 * Returns null when the level is no set of rooms (a box starts in the
 * hallway, a goal is cut away, or some part's boxes and goals differ).
 */
function detectRooms(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const dir of DIRS) {
        const q = squares[i] + dir.dy * w + dir.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level's text into a moves string (possibly empty). */
function solveLevel(text) {
  const level = parseBoard(text);
  const rooms = detectRooms(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      // The other rooms' boxes stand as walls (on their goals once solved).
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const s of other.done ? other.goals : other.boxes) wall[s] = 1;
      }
      const sub = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals,
        boxes: room.boxes,
        player,
      };
      const solved = pushSearch(sub, ASTAR_BUDGET, true) ?? pushSearch(sub, BFS_BUDGET, false);
      if (solved === null) return ''; // honest failure: a valid empty answer
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    return moves;
  }
  // No rooms detected: solve the whole level at once.
  const solved = pushSearch(level, ASTAR_BUDGET, true) ?? pushSearch(level, BFS_BUDGET, false);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
