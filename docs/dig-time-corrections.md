# Dig-time corrections

Cairn ships a small local correction to Minecraft's block-breaking time in
[`src/control/dig_time.js`](../src/control/dig_time.js). It exists because the
registry data Mineflayer / `prismarine-block` use to compute dig time is wrong
for modern ores: the tool-speed multiplier lookup misses, so it **over-estimates**
mining time — for a diamond ore mined with a netherite pickaxe, by roughly 9×.

This note documents the bug, proves it, and describes the workaround, so the
correction in `dig_time.js` reads as deliberate rather than mysterious.

## Root cause

`prismarine-block`'s `digTime()` derives the tool-speed multiplier from
`registry.materials[block.material][heldItemType]`. For modern ores the relevant
`materials` entry's tool-id keys are **disjoint** from the actual harvesting
pickaxes listed in the block's own `harvestTools`, so the lookup misses,
`isBestTool` is false, and `blockBreakingSpeed` stays at `1`. The result is a dig
time computed as if the block were being mined bare-handed — even with the correct
pickaxe equipped.

The disjoint sets are visible directly against the installed data:

```bash
node -e "const mcd=require('minecraft-data')('1.21.11'); const b=mcd.blocksByName.iron_ore;
console.log('material        ', b.material);
console.log('harvestTools    ', Object.keys(b.harvestTools));
console.log('materials lookup', Object.keys(mcd.materials[b.material]));"
# material         incorrect_for_wooden_tool
# harvestTools     [ '918', '923', '933', '938', '943' ]   <- the real pickaxes
# materials lookup [ '912', '913', '914', '915' ]          <- disjoint; lookup misses
```

## Proof

The executable proof lives in
[`test/offline/dig_time_fallback.test.js`](../test/offline/dig_time_fallback.test.js),
which runs against real `prismarine-registry` / `prismarine-block` data:

- the registry path computes **4550 ms** to mine a diamond ore with a netherite
  pickaxe;
- the corrected estimate is **500 ms** (≈ the real in-game time);

a 9.1× over-estimate. The same test confirms the correction still preserves the
*genuine* penalties — airborne (÷5) and submerged-without-aqua-affinity (÷5) — so
it only fixes the bug, it doesn't paper over real slowdowns.

## Workaround

`dig_time.js` wraps `bot.digTime` and recomputes the dig time from a vanilla
tool-speed table (`wooden 2 … iron 6 … netherite 9 … golden 12`), applying the
standard modifiers (efficiency, haste, mining fatigue, aqua-affinity, airborne,
hardness, `canHarvest`). Crucially it **only** overrides the registry result when
its own estimate is *lower* — it corrects the over-estimate and never lets the bot
dig faster than vanilla would allow. When the registry value is already correct, it
is left untouched.

## Upstream

These are registry-data issues, not Cairn bugs, so they have been reported upstream
to PrismarineJS (`minecraft-data` / `mineflayer`). The local correction is a
belt-and-suspenders measure that keeps mining timing accurate regardless of which
`minecraft-data` release is installed.
