// Skill registry. Maps name -> { run, schema }.
// The executor uses this; the advisor planner uses validateSkillCall().

import * as observe from './observe.js';
import * as goto from './goto.js';
import * as collect from './collect.js';
import * as deposit from './deposit.js';
import * as equip from './equip.js';
import * as consume from './consume.js';
import * as flee from './flee.js';
import * as logout from './logout.js';
import * as recoverDrops from './recover_drops.js';
import * as craft from './craft.js';
import * as buildFromSchematic from './build_from_schematic.js';
import * as fishUntil from './fish_until.js';
import * as fishAndDeposit from './fish_and_deposit.js';
import * as mineUntil from './mine_until.js';
import * as mineAndReturn from './mine_and_return.js';
import * as mineWithProgression from './mine_with_progression.js';
import * as placeWorkstation from './place_workstation.js';
import * as smelt from './smelt.js';

import { SKILLS, validateSkillCall, validatePlan } from './schema.js';

export const SKILL_REGISTRY = {
  observe: observe.run,
  goto: goto.run,
  collect: collect.run,
  deposit: deposit.run,
  equip: equip.run,
  consume: consume.run,
  flee: flee.run,
  logout: logout.run,
  recover_drops: recoverDrops.run,
  craft: craft.run,
  build_from_schematic: buildFromSchematic.run,
  fish_until: fishUntil.run,
  fish_and_deposit: fishAndDeposit.run,
  mine_until: mineUntil.run,
  mine_and_return: mineAndReturn.run,
  mine_with_progression: mineWithProgression.run,
  place_workstation: placeWorkstation.run,
  smelt: smelt.run,
};

export { SKILLS, validateSkillCall, validatePlan };
export default SKILL_REGISTRY;
