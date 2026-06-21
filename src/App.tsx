import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Clock3,
  Copy,
  Crown,
  DoorOpen,
  Loader2,
  LogOut,
  Play,
  RefreshCw,
  Shield,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  RESOURCES,
  RESOURCE_LIST,
  buildRevealRows,
  createRoom,
  finalizeReveal,
  getHistory,
  getRoom,
  getTeamSelection,
  getTeams,
  isTeamEligibleForRound,
  joinRoom,
  listAdminRooms,
  markRoomRevealing,
  resolveTeam,
  startRound,
  submitSelection,
} from './lib/game';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import type { HistoryRow, Resource, RevealRow, Room, Selection, Team } from './types';

type Route = {
  path: string;
  navigate: (to: string) => void;
};

const ADMIN_EMAIL = 'dhbach13@gmail.com';
const ADMIN_PASSWORD = 'thoi_toi_xin_ban';
const ADMIN_SESSION_KEY = 'admin_authenticated';

function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setPath(window.location.pathname + window.location.search);
  }, []);

  return { path, navigate };
}

function useAdminAuth() {
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem(ADMIN_SESSION_KEY) === 'true');

  const login = useCallback((email: string, password: string) => {
    if (email.trim() !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      throw new Error('Sai email hoặc mật khẩu admin.');
    }
    localStorage.setItem(ADMIN_SESSION_KEY, 'true');
    setIsAdmin(true);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(ADMIN_SESSION_KEY);
    setIsAdmin(false);
  }, []);

  return { isAdmin, login, logout };
}

function useCountdown(countdownEnd: string | null | undefined) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!countdownEnd) {
      setSeconds(0);
      return;
    }

    const tick = () => {
      setSeconds(Math.max(0, Math.ceil((new Date(countdownEnd).getTime() - Date.now()) / 1000)));
    };

    tick();
    const intervalId = window.setInterval(tick, 300);
    return () => window.clearInterval(intervalId);
  }, [countdownEnd]);

  return seconds;
}

function isCountdownExpired(countdownEnd: string | null | undefined) {
  if (!countdownEnd) return false;
  return Date.now() >= new Date(countdownEnd).getTime();
}

function App() {
  const route = useRoute();
  const { isAdmin, login, logout } = useAdminAuth();
  const roomMatch = route.path.match(/^\/admin\/rooms\/([^?]+)/);

  if (!isSupabaseConfigured) {
    return <SetupRequired />;
  }

  if (route.path.startsWith('/admin')) {
    if (!isAdmin) return <AuthPage onLogin={login} />;
    if (roomMatch) return <AdminRoomPage roomId={roomMatch[1]} navigate={route.navigate} />;
    return <Dashboard navigate={route.navigate} onLogout={logout} />;
  }

  return <TeamPage navigate={route.navigate} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => (window.location.href = '/')}>
          <Sparkles size={22} />
          <span>Phân bổ tài nguyên</span>
        </button>
        <nav className="topbar-actions">
          <a href="/">Team</a>
          <a href="/admin">Admin</a>
        </nav>
      </header>
      {children}
    </main>
  );
}

function SetupRequired() {
  return (
    <Shell>
      <section className="hero">
        <div>
          <p className="eyebrow">Cấu hình Supabase</p>
          <h1>Thêm biến môi trường để chạy game</h1>
          <p>
            Tạo file <code>.env.local</code> từ <code>.env.example</code>, điền Supabase URL và anon key, rồi chạy lại
            server dev.
          </p>
        </div>
        <div className="setup-panel">
          <code>VITE_SUPABASE_URL=https://...</code>
          <code>VITE_SUPABASE_ANON_KEY=eyJ...</code>
        </div>
      </section>
    </Shell>
  );
}

function AuthPage({ onLogin }: { onLogin: (email: string, password: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể xác thực admin.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <section className="auth-layout">
        <div>
          <p className="eyebrow">Admin console</p>
          <h1>Điều phối từng lượt chơi trong một bảng điều khiển gọn gàng.</h1>
          <p>
            Tạo phòng, gửi mã cho đội chơi, bắt đầu countdown, reveal lựa chọn và cộng điểm khi đóng popup kết quả.
          </p>
        </div>

        <form className="panel auth-form" onSubmit={submit}>

          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </label>
          <label>
            Mật khẩu
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              minLength={6}
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary-action" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <Shield size={18} />}
            Vào dashboard
          </button>
        </form>
      </section>
    </Shell>
  );
}

function Dashboard({ navigate, onLogout }: { navigate: (to: string) => void; onLogout: () => void }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRooms(await listAdminRooms());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được danh sách phòng.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createNewRoom() {
    setBusy(true);
    setError('');
    try {
      const room = await createRoom();
      navigate(`/admin/rooms/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tạo được phòng.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <section className="section-heading">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Phòng của bạn</h1>
        </div>
        <div className="actions">
          <button className="secondary-action" type="button" onClick={onLogout}>
            <LogOut size={17} />
            Đăng xuất
          </button>
          <button className="primary-action" type="button" onClick={createNewRoom} disabled={busy}>
            {busy ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            Tạo phòng mới
          </button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <LoadingState label="Đang tải phòng" />
      ) : rooms.length === 0 ? (
        <EmptyState title="Chưa có phòng nào" detail="Tạo phòng mới để lấy mã 6 ký tự cho đội chơi." />
      ) : (
        <div className="room-grid">
          {rooms.map((room) => (
            <button className="room-tile" type="button" key={room.id} onClick={() => navigate(`/admin/rooms/${room.id}`)}>
              <span className="room-code">{room.code}</span>
              <span className={`status-pill ${room.status}`}>{room.status}</span>
              <span>Lượt {room.current_round}</span>
            </button>
          ))}
        </div>
      )}
    </Shell>
  );
}

function AdminRoomPage({ roomId, navigate }: { roomId: string; navigate: (to: string) => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [revealRows, setRevealRows] = useState<RevealRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seconds = useCountdown(room?.countdown_end);
  const revealGuard = useRef('');

  const loadAll = useCallback(async () => {
    try {
      const nextRoom = await getRoom(roomId);
      const [nextTeams, nextHistory] = await Promise.all([getTeams(roomId), getHistory(roomId)]);
      setRoom(nextRoom);
      setTeams(nextTeams);
      setHistory(nextHistory);
      if (nextRoom.status === 'revealing') {
        setRevealRows(await buildRevealRows(nextRoom));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không tải được phòng.');
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    const channel = supabase
      .channel(`admin-room-${roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `room_id=eq.${roomId}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'selections', filter: `room_id=eq.${roomId}` }, loadAll)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadAll, roomId]);

  useEffect(() => {
    if (!room || room.status !== 'playing' || !isCountdownExpired(room.countdown_end)) return;
    const key = `${room.id}-${room.current_round}-${room.countdown_end}`;
    if (revealGuard.current === key) return;
    revealGuard.current = key;
    markRoomRevealing(room).catch((err) => setError(err instanceof Error ? err.message : 'Không chuyển reveal được.'));
  }, [room, seconds]);

  async function handleStart(restart = false) {
    if (!room) return;
    setBusy(true);
    setError('');
    try {
      await startRound(room, restart);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không bắt đầu được lượt.');
    } finally {
      setBusy(false);
    }
  }

  async function closeReveal() {
    if (!room) return;
    setBusy(true);
    setError('');
    try {
      await finalizeReveal(room);
      setRevealRows([]);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể chốt điểm.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Shell><LoadingState label="Đang tải phòng" /></Shell>;
  if (!room) return <Shell><EmptyState title="Không tìm thấy phòng" detail="Kiểm tra lại đường dẫn phòng admin." /></Shell>;

  return (
    <Shell>
      <section className="room-header">
        <button className="link-button" type="button" onClick={() => navigate('/admin')}>
          Quay lại dashboard
        </button>
        <div>
          <p className="eyebrow">Room manager</p>
          <h1>Mã phòng {room.code}</h1>
        </div>
        <button className="icon-action" type="button" onClick={() => navigator.clipboard.writeText(room.code)} title="Copy mã phòng">
          <Copy size={18} />
        </button>
      </section>

      {error && <p className="error">{error}</p>}

      <section className="control-band">
        <Stat icon={<Users size={20} />} label="Đội" value={`${teams.length}/4`} />
        <Stat icon={<BarChart3 size={20} />} label="Lượt" value={String(room.current_round)} />
        <Stat icon={<Clock3 size={20} />} label="Countdown" value={room.status === 'playing' ? `${seconds}s` : '--'} />
        <span className={`status-pill ${room.status}`}>{room.status}</span>
        <div className="actions">
          <button className="secondary-action" type="button" onClick={() => handleStart(true)} disabled={busy || room.current_round === 0}>
            <RefreshCw size={17} />
            Restart
          </button>
          <button className="primary-action" type="button" onClick={() => handleStart(false)} disabled={busy || room.status === 'revealing'}>
            <Play size={17} />
            Bắt đầu lượt
          </button>
        </div>
      </section>

      <section className="columns">
        <div className="panel">
          <h2>Leaderboard</h2>
          <Leaderboard teams={teams} />
        </div>
        <div className="panel">
          <h2>Đội đã join</h2>
          <TeamList teams={teams} room={room} />
        </div>
      </section>

      <section className="panel">
        <h2>Lịch sử lựa chọn</h2>
        <HistoryTable rows={history} />
      </section>

      {room.status === 'revealing' && (
        <RevealModal rows={revealRows} onClose={closeReveal} busy={busy} round={room.current_round} />
      )}
    </Shell>
  );
}

function TeamPage({ navigate }: { navigate: (to: string) => void }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const seconds = useCountdown(room?.countdown_end);
  const defaultGuard = useRef('');

  const loadFromTeam = useCallback(async (nextTeam: Team) => {
    const nextRoom = await getRoom(nextTeam.room_id);
    const [nextTeams, nextSelection] = await Promise.all([
      getTeams(nextTeam.room_id),
      getTeamSelection(nextTeam.id, nextRoom.current_round),
    ]);
    setTeam(nextTeam);
    setRoom(nextRoom);
    setTeams(nextTeams);
    setSelection(nextSelection);
  }, []);

  const recover = useCallback(async () => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
      setTeam(null);
      setRoom(null);
      setSelection(null);
      setLoading(false);
      return;
    }

    try {
      const resolved = await resolveTeam(token);
      if (!resolved) {
        setError('Link không hợp lệ. Vui lòng join lại phòng.');
        setTeam(null);
        setRoom(null);
      } else {
        await loadFromTeam(resolved);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không khôi phục được phiên đội.');
    } finally {
      setLoading(false);
    }
  }, [loadFromTeam]);

  useEffect(() => {
    recover();
  }, [recover]);

  useEffect(() => {
    if (!team || !room) return;
    const channel = supabase
      .channel(`team-room-${room.id}-${team.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${room.id}` }, () => loadFromTeam(team))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams', filter: `room_id=eq.${room.id}` }, () => loadFromTeam(team))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'selections', filter: `room_id=eq.${room.id}` }, () => loadFromTeam(team))
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadFromTeam, room, team]);

  useEffect(() => {
    if (!team || !room || room.status !== 'playing' || selection || !isCountdownExpired(room.countdown_end)) return;
    if (!isTeamEligibleForRound(team, room)) return;
    const key = `${team.id}-${room.current_round}-${room.countdown_end}`;
    if (defaultGuard.current === key) return;
    defaultGuard.current = key;
    submitSelection(team, room, 'gold', true)
      .then(() => loadFromTeam(team))
      .catch((err) => setError(err instanceof Error ? err.message : 'Không auto-chọn được vàng.'));
  }, [loadFromTeam, room, seconds, selection, team]);

  async function handleJoined(nextTeam: Team) {
    window.history.replaceState({}, '', `/play?token=${nextTeam.session_token}`);
    await loadFromTeam(nextTeam);
    navigate(`/play?token=${nextTeam.session_token}`);
  }

  async function choose(resource: Resource) {
    if (!team || !room) return;
    setError('');
    setInfo('');
    try {
      await submitSelection(team, room, resource);
      await loadFromTeam(team);
      setInfo(`Đã chọn: ${RESOURCES[resource].label}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không gửi được lựa chọn.');
    }
  }

  if (loading) return <Shell><LoadingState label="Đang khôi phục phiên đội" /></Shell>;
  if (!team || !room) return <JoinScreen onJoined={handleJoined} initialError={error} />;

  const canChoose =
    room.status === 'playing' &&
    isTeamEligibleForRound(team, room) &&
    !selection &&
    seconds > 0;
  const lateJoin = room.status === 'playing' && !isTeamEligibleForRound(team, room);

  return (
    <Shell>
      <section className="team-hero">
        <div>
          <p className="eyebrow">Team console</p>
          <h1>{team.name}</h1>
          <p>
            Phòng <strong>{room.code}</strong> · Lượt {room.current_round || 0}
          </p>
        </div>
        <div className="score-badge">
          <Crown size={22} />
          <span>{team.score}</span>
          <small>điểm</small>
        </div>
      </section>

      {error && <p className="error">{error}</p>}
      {info && <p className="success">{info}</p>}

      <section className="play-surface">
        <div className="round-status">
          <span className={`status-pill ${room.status}`}>{room.status}</span>
          <strong>{room.status === 'playing' ? `${seconds}s` : 'Chờ admin'}</strong>
        </div>

        {room.status === 'waiting' && <EmptyState title="Đang chờ lượt mới" detail="Admin sẽ bắt đầu countdown khi các đội đã sẵn sàng." />}
        {lateJoin && <EmptyState title="Bạn sẽ tham gia từ lượt tiếp theo" detail="Lượt hiện tại đã bắt đầu trước khi đội join phòng." />}
        {room.status === 'revealing' && <EmptyState title="Đang chờ kết quả" detail="Admin đang xem popup reveal và chốt điểm cho lượt này." />}
        {selection && room.status === 'playing' && (
          <EmptyState
            title={`Đã chọn: ${RESOURCES[selection.resource].label}`}
            detail={selection.is_default ? 'Hệ thống đã tự chọn vàng khi hết giờ.' : 'Lựa chọn đã được ghi nhận.'}
          />
        )}
        {canChoose && (
          <div className="resource-grid">
            {RESOURCE_LIST.map((resource) => (
              <button
                className="resource-choice"
                type="button"
                key={resource.value}
                style={{ borderColor: resource.accent }}
                onClick={() => choose(resource.value)}
              >
                <span>{resource.label}</span>
                <strong>{resource.points}</strong>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Đội trong phòng</h2>
        <TeamList teams={teams} room={room} />
      </section>
    </Shell>
  );
}

function JoinScreen({ onJoined, initialError }: { onJoined: (team: Team) => Promise<void>; initialError?: string }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || '');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const team = await joinRoom(name, code);
      await onJoined(team);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể join phòng.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <section className="auth-layout">
        <div>
          <p className="eyebrow">Team join</p>
          <h1>Nhập mã phòng và chọn tài nguyên khi countdown bắt đầu.</h1>
          <p>Mỗi lượt chỉ chọn một lần. Nếu hết giờ mà chưa chọn, hệ thống sẽ tính mặc định là vàng.</p>
        </div>
        <form className="panel auth-form" onSubmit={submit}>
          <label>
            Tên đội
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={40} />
          </label>
          <label>
            Mã phòng
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              required
              maxLength={6}
              className="code-input"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary-action" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <DoorOpen size={18} />}
            Join phòng
          </button>
        </form>
      </section>
    </Shell>
  );
}

function RevealModal({ rows, round, busy, onClose }: { rows: RevealRow[]; round: number; busy: boolean; onClose: () => void }) {
  const eligibleRows = rows.filter((row) => row.eligible);
  const totals = useMemo(() => {
    return RESOURCE_LIST.map((resource) => ({
      ...resource,
      count: eligibleRows.filter((row) => row.effectiveResource === resource.value).length,
    }));
  }, [eligibleRows]);

  return (
    <div className="modal-backdrop">
      <section className="modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Reveal</p>
            <h2>Kết quả lượt {round}</h2>
          </div>
          <button className="icon-action" type="button" onClick={onClose} disabled={busy} title="Đóng và tính điểm">
            {busy ? <Loader2 className="spin" size={18} /> : <X size={18} />}
          </button>
        </header>

        <div className="resource-summary">
          {totals.map((total) => (
            <span key={total.value}>
              {total.shortLabel}: <strong>{total.count}</strong>
            </span>
          ))}
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Đội</th>
                <th>Lựa chọn</th>
                <th>Điểm lượt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.team.id}>
                  <td>{row.team.name}</td>
                  <td>
                    {row.eligible
                      ? `${RESOURCES[row.effectiveResource].label}${row.isDefault ? ' (không chọn)' : ''}`
                      : 'Tham gia từ lượt sau'}
                  </td>
                  <td>{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Leaderboard({ teams }: { teams: Team[] }) {
  if (teams.length === 0) return <EmptyState title="Chưa có đội" detail="Gửi mã phòng cho các đội để họ join." />;
  return (
    <ol className="leaderboard">
      {teams.map((team, index) => (
        <li key={team.id}>
          <span className="rank">#{index + 1}</span>
          <span>{team.name}</span>
          <strong>{team.score}</strong>
        </li>
      ))}
    </ol>
  );
}

function TeamList({ teams, room }: { teams: Team[]; room: Room }) {
  if (teams.length === 0) return <EmptyState title="Chưa có đội" detail="Tối đa 4 đội trong một phòng." />;
  return (
    <div className="team-list">
      {teams.map((team) => (
        <div className="team-row" key={team.id}>
          <span>{team.name}</span>
          <small>{isTeamEligibleForRound(team, room) ? 'Có thể tính lượt hiện tại' : 'Từ lượt sau'}</small>
          <strong>{team.score}</strong>
        </div>
      ))}
    </div>
  );
}

function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  if (rows.length === 0) return <EmptyState title="Chưa có lịch sử" detail="Lịch sử sẽ xuất hiện sau khi admin chốt reveal." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Lượt</th>
            <th>Đội</th>
            <th>Tài nguyên</th>
            <th>Điểm</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.round_number}</td>
              <td>{row.teamName}</td>
              <td>{RESOURCES[row.resource].label}{row.is_default ? ' (mặc định)' : ''}</td>
              <td>{row.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="stat">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-state">
      <Loader2 className="spin" size={28} />
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export default App;
