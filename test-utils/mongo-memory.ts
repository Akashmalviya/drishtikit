import { MongoMemoryServer } from 'mongodb-memory-server';

/** Start a throw-away MongoDB in memory for a test run. Tests never use a real database. */
export async function startMongo(): Promise<{ uri: string; stop: () => Promise<void> }> {
  const server = await MongoMemoryServer.create();
  return { uri: server.getUri(), stop: async () => void (await server.stop()) };
}
