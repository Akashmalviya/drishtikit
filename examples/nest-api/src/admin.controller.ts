import { CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, Query, UseGuards } from '@nestjs/common';
import { DrishtiReader } from '@drishtikit/nest';
import { TEAMS } from './data';

/** The app's own guard. Only admins read usage. Drishtikit opens no read endpoint itself. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    return req.headers['x-role'] === 'admin';
  }
}

/** The dashboard backend: read functions from Drishtikit, joined with the app's own data. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(DrishtiReader) private readonly drishti: DrishtiReader) {}

  @Get('overview')
  overview(@Query('days') days = '30') {
    return this.drishti.overview({ days: Number(days) });
  }

  /** Usage for each team, with the team names from the app's own data. */
  @Get('teams')
  async teams(@Query('days') days = '30') {
    const usage = await this.drishti.query({ metrics: ['activePeople', 'calls'], by: ['group'], days: Number(days) });
    const byId = new Map(usage.rows.map((r) => [r.group, r]));
    return TEAMS.map((t) => ({
      id: t.id,
      name: t.name,
      activePeople: Number(byId.get(t.id)?.activePeople ?? 0),
      calls: Number(byId.get(t.id)?.calls ?? 0),
    }));
  }

  @Get('health')
  health() {
    return this.drishti.health();
  }
}
