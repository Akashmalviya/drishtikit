import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { EventEmitter2 } from 'eventemitter2';
import { TEAMS, type Role, type Team } from './data';

/**
 * Business code. It does not import Drishtikit.
 * It only emits a domain event, which the Drishtikit module can count.
 */
@Controller()
export class TeamsController {
  private readonly teams: Team[] = structuredClone(TEAMS);

  constructor(@Inject(EventEmitter2) private readonly events: EventEmitter2) {}

  @Get('health')
  health(): { ok: boolean } {
    return { ok: true };
  }

  @Get('teams')
  list(): Array<{ id: string; name: string; size: number }> {
    return this.teams.map((t) => ({ id: t.id, name: t.name, size: t.members.length }));
  }

  @Get('teams/:id')
  one(@Param('id') id: string): Team {
    const team = this.teams.find((t) => t.id === id);
    if (!team) throw new NotFoundException();
    return team;
  }

  @Get('teams/:id/members')
  members(@Param('id') id: string): Team['members'] {
    return this.one(id).members;
  }

  @Post('teams/:id/members')
  add(@Param('id') id: string, @Body() body: { name?: string; role?: Role }): { id: string } {
    const team = this.one(id);
    const member = { id: `u${100 + team.members.length}`, name: String(body?.name ?? 'New member').slice(0, 40), role: body?.role ?? 'member' };
    team.members.push(member);
    this.events.emit('member.added', { teamId: id, userId: member.id });
    return { id: member.id };
  }
}
