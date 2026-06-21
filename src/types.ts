export type RoomStatus = 'waiting' | 'playing' | 'revealing';
export type Resource = 'gold' | 'oil' | 'labor';

export type Room = {
  id: string;
  code: string;
  admin_id: string;
  current_round: number;
  status: RoomStatus;
  countdown_end: string | null;
  created_at: string;
};

export type Team = {
  id: string;
  room_id: string;
  name: string;
  score: number;
  session_token: string;
  created_at: string;
};

export type Selection = {
  id: string;
  room_id: string;
  team_id: string;
  round_number: number;
  resource: Resource;
  is_default: boolean;
  created_at: string;
};

export type ResourceInfo = {
  value: Resource;
  label: string;
  shortLabel: string;
  points: number;
  accent: string;
};

export type RevealRow = {
  team: Team;
  selection: Selection | null;
  effectiveResource: Resource;
  isDefault: boolean;
  points: number;
  eligible: boolean;
};

export type HistoryRow = Selection & {
  teamName: string;
  points: number;
};
