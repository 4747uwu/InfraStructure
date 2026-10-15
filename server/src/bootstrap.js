import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { settings, SETTINGS_ID, users } from './db.js';
import { hashPassword, newToken } from './security.js';

// First-boot setup: storage folders, the link-signing secret, and the two accounts.
// Safe to run on every start - it only fills in what is missing.
export async function bootstrap() {
  await mkdir(join(config.storageDir, '.incoming'), { recursive: true });

  await settings().updateOne(
    { _id: SETTINGS_ID },
    { $setOnInsert: { linkSecret: newToken(32), downloadPassword: null, deployToken: null, createdAt: new Date() } },
    { upsert: true },
  );

  for (const role of ['master', 'helper']) {
    if (await users().findOne({ role })) continue;
    const seed = config.seed[role];
    // A malformed hash would create an account nobody can sign in to; refuse to start instead.
    if (seed.passwordHash && !/^scrypt\$[\w-]+\$[\w-]+$/.test(seed.passwordHash)) {
      throw new Error(`${role.toUpperCase()}_PASSWORD_HASH is not a valid password hash.`);
    }
    const password = seed.passwordHash ? null : seed.password || newToken(9);
    await users().insertOne({
      username: seed.username.trim().toLowerCase(),
      role,
      passwordHash: seed.passwordHash || (await hashPassword(password)),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (seed.passwordHash) console.log(`  Created ${role} account "${seed.username}" (password from ${role.toUpperCase()}_PASSWORD_HASH)`);
    else if (seed.password) console.log(`  Created ${role} account "${seed.username}" (password from .env)`);
    else console.log(`  Created ${role} account "${seed.username}" with generated password: ${password}`);
  }
}
