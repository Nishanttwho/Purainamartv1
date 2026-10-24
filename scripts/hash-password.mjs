import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPassword, validPassword } from '../lib/password.mjs';

const rl = createInterface({ input: stdin, output: stdout });
try {
  const password = await rl.question('Enter the Admin password to hash (minimum 12 characters): ');
  if (!validPassword(password)) throw new Error('Password must be 12–128 characters and contain no control characters.');
  console.log('\nADMIN_PASSWORD_HASH=' + await hashPassword(password));
  console.log('Copy the hash into the server environment. The plaintext password is not written to a file.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
