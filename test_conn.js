import { createClient } from '@libsql/client/web';
import dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.LIBSQL_DB_URL,
  authToken: process.env.LIBSQL_DB_TOKEN,
});

client.getIsSchemaDatabase = async () => false;

async function main() {
  try {
    console.log('Testing minimal CREATE TABLE...');
    const res = await client.execute('CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY)');
    console.log('Success! Table created. Res:', res);
  } catch (err) {
    console.error('Create table failed:', err);
  }
}

main();
