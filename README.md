# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ayubzoel/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ayubzoel/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver" bounty. It splits each level into its rooms (a box pushed into the hallway can never return, so rooms are independent), solves every room on its own with A* over pushes — state = sorted box squares + the player's reachable region, estimate = cheapest box-to-goal assignment by Manhattan distance, deadlocks pruned by reverse-pull live squares and frozen 2×2 blocks — then chains the rooms together, walking the player through the hallway between them.

## Results (local, kit scorer)

| Set | Score | Notes |
| --- | --- | --- |
| Practice (i001–i005) | **1,000,000** | All 5 instances at P\* (13/16/29/47/60 pushes), ~1.6 s total |
| 3 freshly drawn sets | **1,000,000** each | All 15 extra instances at P\*, ~0.4 s per set |
| House baseline plain-astar 1.0.0 | 200,000 (practice) / 400,000 (fresh set) | Solves only the 1–2 smallest instances |

Output is deterministic: two runs produce byte-identical `solution.txt` files.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts
```

`main.ts` is plain Node 22 (no dependencies, no network, no clock or randomness — search budgets are counted in states, never in wall-clock time).

---

<sub>Entered on [make.fun](https://make.fun/?ref=v916a3tf&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
