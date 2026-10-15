import { MongoClient, ObjectId } from 'mongodb';
import { config } from './config.js';

let client;
let db;

export async function connect() {
  client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(config.dbName);

  await Promise.all([
    users().createIndex({ username: 1 }, { unique: true }),
    users().createIndex({ role: 1 }, { unique: true }),
    sessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    clients().createIndex({ slug: 1 }, { unique: true }),
    clients().createIndex({ directToken: 1 }, { unique: true }),
    clients().createIndex({ protectedToken: 1 }, { unique: true }),
    releases().createIndex({ clientId: 1, uploadedAt: -1 }),
    releases().createIndex({ clientId: 1, sha256: 1 }),
    releases().createIndex({ directToken: 1 }, { unique: true }),
    releases().createIndex({ protectedToken: 1 }, { unique: true }),
  ]);
  return db;
}

export const close = () => client?.close();
export const ping = () => db.command({ ping: 1 });

export const users = () => db.collection('users');
export const sessions = () => db.collection('sessions');
export const clients = () => db.collection('clients');
export const releases = () => db.collection('releases');
export const settings = () => db.collection('settings');

export const SETTINGS_ID = 'main';
export const getSettings = () => settings().findOne({ _id: SETTINGS_ID });

export function toObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value) ? new ObjectId(value) : null;
}

export { ObjectId };
