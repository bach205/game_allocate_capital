import { supabase, requireSupabaseConfig } from './supabase';
import type { HistoryRow, Resource, RevealRow, Room, Selection, Team } from '../types';

export const ROUND_SECONDS = 10;

export const RESOURCES: Record<Resource, { label: string; shortLabel: string; points: number; accent: string }> = {
  gold: { label: 'Vàng', shortLabel: 'Vàng', points: 180, accent: '#f2b705' },
  oil: { label: 'Dầu mỏ', shortLabel: 'Dầu', points: 320, accent: '#334155' },
  labor: { label: 'Lao động', shortLabel: 'Lao động', points: 450, accent: '#0f9f6e' },
};

export const RESOURCE_LIST = Object.entries(RESOURCES).map(([value, info]) => ({
  value: value as Resource,
  ...info,
}));

function raise(message: string): never {
  throw new Error(message);
}

function handleError(error: { message: string } | null) {
  if (error) raise(error.message);
}

export function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export function getRoundStart(room: Room) {
  if (!room.countdown_end) return null;
  return new Date(new Date(room.countdown_end).getTime() - ROUND_SECONDS * 1000);
}

export function isTeamEligibleForRound(team: Team, room: Room) {
  if (room.current_round <= 0) return false;
  const startedAt = getRoundStart(room);
  if (!startedAt) return true;
  return new Date(team.created_at).getTime() <= startedAt.getTime() + 1500;
}

export function calculatePoints(selections: Selection[]) {
  const byResource = selections.reduce<Record<Resource, Selection[]>>(
    (groups, selection) => {
      groups[selection.resource].push(selection);
      return groups;
    },
    { gold: [], oil: [], labor: [] },
  );

  return selections.reduce<Record<string, number>>((scores, selection) => {
    const groupSize = byResource[selection.resource].length || 1;
    scores[selection.team_id] = Math.floor(RESOURCES[selection.resource].points / groupSize);
    return scores;
  }, {});
}

export async function listAdminRooms() {
  requireSupabaseConfig();
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .order('created_at', { ascending: false });
  handleError(error);
  return (data || []) as Room[];
}

export async function createRoom() {
  requireSupabaseConfig();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await supabase
      .from('rooms')
      .insert({ code: generateRoomCode(), admin_id: null, status: 'waiting' })
      .select()
      .single();

    if (!error) return data as Room;
    if (!error.message.toLowerCase().includes('duplicate')) handleError(error);
  }
  raise('Không tạo được mã phòng duy nhất. Vui lòng thử lại.');
}

export async function getRoom(roomId: string) {
  const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId).single();
  handleError(error);
  return data as Room;
}

export async function getRoomByCode(code: string) {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .maybeSingle();
  handleError(error);
  return data as Room | null;
}

export async function getTeams(roomId: string) {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .eq('room_id', roomId)
    .order('score', { ascending: false })
    .order('created_at', { ascending: true });
  handleError(error);
  return (data || []) as Team[];
}

export async function getSelections(roomId: string, roundNumber: number) {
  const { data, error } = await supabase
    .from('selections')
    .select('*')
    .eq('room_id', roomId)
    .eq('round_number', roundNumber);
  handleError(error);
  return (data || []) as Selection[];
}

export async function getTeamSelection(teamId: string, roundNumber: number) {
  if (roundNumber <= 0) return null;
  const { data, error } = await supabase
    .from('selections')
    .select('*')
    .eq('team_id', teamId)
    .eq('round_number', roundNumber)
    .maybeSingle();
  handleError(error);
  return data as Selection | null;
}

export async function joinRoom(teamName: string, roomCode: string) {
  requireSupabaseConfig();
  const room = await getRoomByCode(roomCode);
  if (!room) raise('Phòng không tồn tại.');

  const { count, error: countError } = await supabase
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('room_id', room.id);
  handleError(countError);
  if ((count || 0) >= 4) raise('Phòng đã đủ 4 đội.');

  const token = crypto.randomUUID();
  const { data, error } = await supabase
    .from('teams')
    .insert({
      room_id: room.id,
      name: teamName.trim(),
      session_token: token,
    })
    .select()
    .single();
  handleError(error);
  return data as Team;
}

export async function resolveTeam(token: string) {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .eq('session_token', token)
    .maybeSingle();
  handleError(error);
  if (!data) return null;
  return data as Team;
}

export async function startRound(room: Room, restart = false) {
  requireSupabaseConfig();
  const nextRound = restart ? room.current_round : room.current_round + 1;

  if (restart && room.current_round > 0) {
    const { error } = await supabase
      .from('selections')
      .delete()
      .eq('room_id', room.id)
      .eq('round_number', room.current_round);
    handleError(error);
  }

  const { data, error } = await supabase
    .from('rooms')
    .update({
      current_round: nextRound,
      status: 'playing',
      countdown_end: new Date(Date.now() + ROUND_SECONDS * 1000).toISOString(),
    })
    .eq('id', room.id)
    .select()
    .single();
  handleError(error);
  return data as Room;
}

export async function markRoomRevealing(room: Room) {
  if (room.status !== 'playing') return;
  const { error } = await supabase
    .from('rooms')
    .update({ status: 'revealing' })
    .eq('id', room.id)
    .eq('status', 'playing');
  handleError(error);
}

export async function submitSelection(team: Team, room: Room, resource: Resource, isDefault = false) {
  if (!isTeamEligibleForRound(team, room)) {
    raise('Đội của bạn sẽ tham gia từ lượt tiếp theo.');
  }

  const { error } = await supabase
    .from('selections')
    .upsert(
      {
        room_id: room.id,
        team_id: team.id,
        round_number: room.current_round,
        resource,
        is_default: isDefault,
      },
      { onConflict: 'team_id,round_number', ignoreDuplicates: true },
    );
  handleError(error);
}

export async function buildRevealRows(room: Room) {
  const [teams, selections] = await Promise.all([getTeams(room.id), getSelections(room.id, room.current_round)]);
  const selectedByTeam = new Map(selections.map((selection) => [selection.team_id, selection]));
  const effectiveSelections = teams
    .filter((team) => isTeamEligibleForRound(team, room))
    .map((team) => selectedByTeam.get(team.id) || ({
      id: `pending-${team.id}`,
      room_id: room.id,
      team_id: team.id,
      round_number: room.current_round,
      resource: 'gold' as Resource,
      is_default: true,
      created_at: new Date().toISOString(),
    }));
  const pointsByTeam = calculatePoints(effectiveSelections as Selection[]);

  return teams.map<RevealRow>((team) => {
    const selection = selectedByTeam.get(team.id) || null;
    const eligible = isTeamEligibleForRound(team, room);
    return {
      team,
      selection,
      eligible,
      effectiveResource: eligible ? selection?.resource || 'gold' : 'gold',
      isDefault: eligible ? !selection || selection.is_default : false,
      points: eligible ? pointsByTeam[team.id] || 0 : 0,
    };
  });
}

export async function finalizeReveal(room: Room) {
  requireSupabaseConfig();
  const { data: lockedRoom, error: lockError } = await supabase
    .from('rooms')
    .update({ status: 'waiting' })
    .eq('id', room.id)
    .eq('status', 'revealing')
    .select()
    .maybeSingle();
  handleError(lockError);
  if (!lockedRoom) return;

  const freshRoom = lockedRoom as Room;
  const teams = (await getTeams(freshRoom.id)).filter((team) => isTeamEligibleForRound(team, freshRoom));
  const selections = await getSelections(freshRoom.id, freshRoom.current_round);
  const selectedIds = new Set(selections.map((selection) => selection.team_id));
  const defaultRows = teams
    .filter((team) => !selectedIds.has(team.id))
    .map((team) => ({
      room_id: freshRoom.id,
      team_id: team.id,
      round_number: freshRoom.current_round,
      resource: 'gold' as Resource,
      is_default: true,
    }));

  if (defaultRows.length > 0) {
    const { error } = await supabase
      .from('selections')
      .upsert(defaultRows, { onConflict: 'team_id,round_number', ignoreDuplicates: true });
    handleError(error);
  }

  const finalSelections = await getSelections(freshRoom.id, freshRoom.current_round);
  const eligibleIds = new Set(teams.map((team) => team.id));
  const roundSelections = finalSelections.filter((selection) => eligibleIds.has(selection.team_id));
  const pointsByTeam = calculatePoints(roundSelections);

  await Promise.all(
    teams.map((team) => {
      const added = pointsByTeam[team.id] || 0;
      return supabase
        .from('teams')
        .update({ score: team.score + added })
        .eq('id', team.id)
        .then(({ error }) => handleError(error));
    }),
  );
}

export async function getHistory(roomId: string) {
  const [teams, selections] = await Promise.all([
    getTeams(roomId),
    supabase.from('selections').select('*').eq('room_id', roomId).order('round_number', { ascending: true }),
  ]);
  handleError(selections.error);

  const teamById = new Map(teams.map((team) => [team.id, team]));
  const grouped = ((selections.data || []) as Selection[]).reduce<Record<number, Selection[]>>((groups, selection) => {
    groups[selection.round_number] ||= [];
    groups[selection.round_number].push(selection);
    return groups;
  }, {});

  const pointsBySelection = new Map<string, number>();
  Object.values(grouped).forEach((roundSelections) => {
    const pointsByTeam = calculatePoints(roundSelections);
    roundSelections.forEach((selection) => pointsBySelection.set(selection.id, pointsByTeam[selection.team_id] || 0));
  });

  return ((selections.data || []) as Selection[]).map<HistoryRow>((selection) => ({
    ...selection,
    teamName: teamById.get(selection.team_id)?.name || 'Đội đã rời phòng',
    points: pointsBySelection.get(selection.id) || 0,
  }));
}
