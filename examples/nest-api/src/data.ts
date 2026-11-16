/** Made-up data for the Acme demo. A real app would read this from its own database. */
export type Role = 'admin' | 'manager' | 'member';

export interface Team {
  id: string;
  name: string;
  members: Array<{ id: string; name: string; role: Role }>;
}

export const TEAMS: Team[] = [
  { id: 't1', name: 'Acme Rockets', members: [{ id: 'u1', name: 'Wile', role: 'admin' }, { id: 'u2', name: 'Road', role: 'member' }] },
  { id: 't2', name: 'Acme Anvils', members: [{ id: 'u3', name: 'Bugs', role: 'manager' }, { id: 'u4', name: 'Daffy', role: 'member' }] },
  { id: 't3', name: 'Acme Magnets', members: [{ id: 'u5', name: 'Elmer', role: 'member' }] },
];
