import 'reflect-metadata';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { DrishtiService } from '@drishtikit/nest';
import { memoryStore } from '@drishtikit/mongo';
import { AcmeModule } from '../src/app.module';

describe('Acme example API', () => {
  it('records usage and gives the admin a dashboard answer that joins the app data', async () => {
    const store = memoryStore();
    const moduleRef = await Test.createTestingModule({ imports: [AcmeModule.register({ store })] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    const http = request(app.getHttpServer());
    const as = (user: string, team: string, role: string) => ({ 'x-user-id': user, 'x-team-id': team, 'x-role': role });

    await http.get('/teams/t1').set(as('u1', 't1', 'admin')).expect(200);
    await http.get('/teams/t1/members').set(as('u2', 't1', 'member')).expect(200);
    await http.post('/teams/t2/members').set(as('u3', 't2', 'manager')).send({ name: 'Newbie' }).expect(201);
    await http.get('/health').expect(200);
    await new Promise((r) => setImmediate(r));

    await http.get('/admin/teams').set(as('u9', 't9', 'member')).expect(403);
    const teams = await http.get('/admin/teams').set(as('u1', 't1', 'admin')).expect(200);
    expect(teams.body).toEqual([
      { id: 't1', name: 'Acme Rockets', activePeople: 2, calls: 2 },
      { id: 't2', name: 'Acme Anvils', activePeople: 1, calls: 1 },
      { id: 't3', name: 'Acme Magnets', activePeople: 0, calls: 0 },
    ]);
    const overview = await http.get('/admin/overview').set(as('u1', 't1', 'admin')).expect(200);
    expect(overview.body.calls).toBeGreaterThanOrEqual(3);
    // The domain event was counted without the controller knowing about Drishtikit.
    await app.get(DrishtiService).flusher.flush({ fast: true });
    const [day] = await store.find('usage_days', { groups: ['t2'] });
    expect(day?.k).toMatchObject({ 'event:member_added': 1 });
    // The health route is excluded.
    const keys = (await store.find('usage_days', {})).flatMap((d) => Object.keys(d.k as object));
    expect(keys).not.toContain('route:GET /health');
    await app.close();
  });

  it('runs without Drishtikit', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AcmeModule.register({ store: null })] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await request(app.getHttpServer()).get('/teams').expect(200);
    await request(app.getHttpServer()).get('/admin/teams').expect(404);
    await app.close();
  });
});
