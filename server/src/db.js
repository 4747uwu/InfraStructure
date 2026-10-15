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
    // Mac "latest" link tokens (Windows ones are the top-level tokens above).
    clients().createIndex({ 'macArm.directToken': 1 }, { unique: true, sparse: true }),
    clients().createIndex({ 'macArm.protectedToken': 1 }, { unique: true, sparse: true }),
    clients().createIndex({ 'macIntel.directToken': 1 }, { unique: true, sparse: true }),
    clients().createIndex({ 'macIntel.protectedToken': 1 }, { unique: true, sparse: true }),
    tasks().createIndex({ status: 1, order: 1 }),
    servers().createIndex({ tokenHash: 1 }, { unique: true }),
    metrics().createIndex({ serverId: 1, at: 1 }),
    // Monitoring history is kept for 30 days, then MongoDB drops it.
    metrics().createIndex({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }),
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
export const tasks = () => db.collection('tasks');
export const servers = () => db.collection('servers');
export const metrics = () => db.collection('metrics');

export const SETTINGS_ID = 'main';
export const getSettings = () => settings().findOne({ _id: SETTINGS_ID });

export function toObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value) ? new ObjectId(value) : null;
}

export { ObjectId };
