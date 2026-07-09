import 'dotenv/config';
import { hash } from 'bcryptjs';
import dataSource from '../typeorm.datasource';
import { UserRole } from '../../../common/enums/user-role.enum';
import { UserEntity } from '../../../modules/users/entities/user.entity';

/* Local dev utility: reset (or create) the admin login to admin / admin12345. */
async function run() {
  await dataSource.initialize();
  const users = dataSource.getRepository(UserEntity);
  const userId = 'admin';
  const password = 'admin12345';
  const passwordHash = await hash(password, 10);

  let admin = await users.findOne({ where: { userId } });
  if (admin) {
    admin.passwordHash = passwordHash;
    await users.save(admin);
    console.log('Reset password for existing admin');
  } else {
    await users.save(
      users.create({ userId, name: 'Platform Admin', passwordHash, role: UserRole.ADMIN, shipId: null }),
    );
    console.log('Created admin user');
  }

  await dataSource.destroy();
  console.log(`Login: ${userId} / ${password}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
