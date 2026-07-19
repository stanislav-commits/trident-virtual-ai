import 'dotenv/config';
import { hash } from 'bcryptjs';
import dataSource from '../typeorm.datasource';
import { UserRole } from '../../../common/enums/user-role.enum';
import { ShipEntity } from '../../../modules/ships/entities/ship.entity';
import { UserEntity } from '../../../modules/users/entities/user.entity';
import { CrewMemberEntity } from '../../../modules/crew/entities/crew-member.entity';
import { PmsTaskEntity } from '../../../modules/pms/entities/pms-task.entity';

/**
 * Seeds a self-contained RBAC test vessel: SeaWolf X (Test) with a crew whose
 * members are linked to login accounts, plus department-tagged PMS tasks so the
 * department-scoping and access matrix can be verified end-to-end.
 *
 * Run:  npm run db:migrate  &&  npx ts-node -r tsconfig-paths/register src/core/database/seeds/test-vessel.seed.ts
 */

const HINT =
  "SeaWolf X — Rossinavi FR051 'Sea Cat 42', 42.7 m aluminium catamaran, RINA, commercial. Twin hulls, each with its own engine room (Port/Stbd). Hybrid diesel-electric: 2× Lucchi LEM1100 PM motors (250 kW) per hull on Siemens BlueDrive off a shared DC bus, ZF 305-3 gearboxes, 4-blade Ø950 counter-rotating props. Power: 2× MASE VS-350 variable-speed gensets + EBUSCO NMC battery (~784 kWh) + shore converters. Metrics come in Port/Stbd pairs (-PS/-SB); a large Port-vs-Stbd divergence is the anomaly to flag.";

// crew member + the login to create for them
const CREW: Array<{
  name: string;
  department: string;
  rank: string;
  rankLevel: number;
  position: string;
  loginId: string;
  password: string;
}> = [
  { name: 'John Carter', department: 'deck', rank: 'Captain', rankLevel: 1, position: 'master', loginId: 'test-master', password: 'master123' },
  { name: 'Erik Lund', department: 'engine', rank: 'Chief Engineer', rankLevel: 1, position: 'hod_engine', loginId: 'test-chiefeng', password: 'chiefeng123' },
  { name: 'Diego Alvarez', department: 'engine', rank: 'Motorman', rankLevel: 4, position: 'engine', loginId: 'test-motorman', password: 'motorman123' },
  { name: 'Mia Rossi', department: 'interior', rank: 'Chief Stewardess', rankLevel: 1, position: 'hod_interior', loginId: 'test-chiefstew', password: 'chiefstew123' },
];

const TASKS: Array<{ task: string; department: string | null; dueDate: string; board?: string; category?: string }> = [
  { task: 'Main Engine Oil Change (Port)', department: 'engine', dueDate: '2026-07-20' },
  { task: 'Sea Water Pump Inspection', department: 'engine', dueDate: '2026-08-01' },
  { task: 'Guest Cabin A/C Filter Clean', department: 'interior', dueDate: '2026-07-15' },
  // Drills are people-work → the general Tasks board, not the maintenance plan.
  { task: 'Monthly Fire & Abandon Ship Drill', department: null, dueDate: '2026-07-10', board: 'general', category: 'Drill' },
];

async function run() {
  await dataSource.initialize();
  const ships = dataSource.getRepository(ShipEntity);
  const users = dataSource.getRepository(UserEntity);
  const crewRepo = dataSource.getRepository(CrewMemberEntity);
  const tasksRepo = dataSource.getRepository(PmsTaskEntity);

  // 1. Ship
  let ship = await ships.findOne({ where: { organizationName: 'test-fleet' } });
  if (!ship) {
    ship = ships.create({
      name: 'SeaWolf X (Test)',
      organizationName: 'test-fleet',
      imoNumber: '9999001',
      flag: 'Malta',
      operationType: 'commercial',
      classSociety: 'RINA',
      shipyard: 'Rossinavi',
      homePort: 'Valletta',
      lengthM: '42.70',
      buildYear: 2026,
      metricAnalysisHint: HINT,
    });
    await ships.save(ship);
    console.log(`Created ship "${ship.name}" (${ship.id})`);
  } else {
    console.log(`Ship "${ship.name}" already exists (${ship.id})`);
  }

  // 2. Crew + linked logins
  for (const c of CREW) {
    let user = await users.findOne({ where: { userId: c.loginId } });
    if (!user) {
      user = await users.save(
        users.create({
          userId: c.loginId,
          name: c.name,
          passwordHash: await hash(c.password, 10),
          role: UserRole.USER,
          shipId: ship.id,
          accessPosition: c.position,
        }),
      );
    } else if (user.accessPosition !== c.position) {
      user.accessPosition = c.position;
      await users.save(user);
    }

    let member = await crewRepo.findOne({
      where: { shipId: ship.id, name: c.name },
    });
    if (!member) {
      member = crewRepo.create({
        shipId: ship.id,
        name: c.name,
        department: c.department,
        rank: c.rank,
        rankLevel: c.rankLevel,
        userId: user.id,
        active: true,
      });
    } else {
      member.userId = user.id;
      member.department = c.department;
      member.rank = c.rank;
      member.rankLevel = c.rankLevel;
    }
    await crewRepo.save(member);
  }

  // 3. Department-tagged PMS tasks
  for (const t of TASKS) {
    const existing = await tasksRepo.findOne({
      where: { shipId: ship.id, task: t.task },
    });
    if (!existing) {
      await tasksRepo.save(
        tasksRepo.create({
          shipId: ship.id,
          task: t.task,
          category: t.category ?? 'Service',
          planning: 'planned',
          department: t.department,
          priority: 'medium',
          dueDate: t.dueDate,
          board: t.board ?? 'maintenance',
        }),
      );
    }
  }

  await dataSource.destroy();

  console.log('\n✅ Test vessel seeded: SeaWolf X (Test)');
  console.log('Crew logins (all linked to crew → RBAC applies):');
  for (const c of CREW) {
    console.log(`  ${c.loginId} / ${c.password}  →  ${c.rank} (${c.department})`);
  }
  console.log(
    '\nPMS tasks: 2× engine, 1× interior (ratings), 1× general. Log in as test-motorman and ask the chat for maintenance tasks — engine + general only.',
  );
}

void run();
