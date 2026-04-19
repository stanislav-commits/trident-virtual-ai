import 'dotenv/config';
import { hash } from 'bcryptjs';
import dataSource from '../typeorm.datasource';
import { UserRole } from '../../../common/enums/user-role.enum';
import { ShipEntity } from '../../../modules/ships/entities/ship.entity';
import { UserEntity } from '../../../modules/users/entities/user.entity';

async function run() {
  await dataSource.initialize();

  const shipRepository = dataSource.getRepository(ShipEntity);
  const userRepository = dataSource.getRepository(UserEntity);

  let demoShip = await shipRepository.findOne({
    where: { organizationName: 'demo-fleet' },
  });

  if (!demoShip) {
    demoShip = shipRepository.create({
      name: 'MV Demo Vessel',
      organizationName: 'demo-fleet',
    });
    await shipRepository.save(demoShip);
  }

  const adminUserId = 'admin';
  const adminPassword = 'admin12345';
  const demoUserId = 'crew-demo';
  const demoUserPassword = 'crew12345';

  const adminHash = await hash(adminPassword, 10);
  const crewHash = await hash(demoUserPassword, 10);

  const existingAdmin = await userRepository.findOne({
    where: { userId: adminUserId },
  });

  if (!existingAdmin) {
    await userRepository.save(
      userRepository.create({
        userId: adminUserId,
        name: 'Platform Admin',
        passwordHash: adminHash,
        role: UserRole.ADMIN,
        shipId: null,
      }),
    );
  }

  const existingCrew = await userRepository.findOne({
    where: { userId: demoUserId },
  });

  if (!existingCrew) {
    await userRepository.save(
      userRepository.create({
        userId: demoUserId,
        name: 'Demo Crew User',
        passwordHash: crewHash,
        role: UserRole.USER,
        shipId: demoShip.id,
      }),
    );
  }

  await dataSource.destroy();

  console.log('Seed complete');
  console.log(`Admin login: ${adminUserId} / ${adminPassword}`);
  console.log(`Crew login: ${demoUserId} / ${demoUserPassword}`);
}

void run();
