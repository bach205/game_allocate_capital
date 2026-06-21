# Game Spec: Resource Allocation Game
**Version:** 1.2  
**Stack:** React (Vite) + Supabase + Vercel

---

## 1. Tổng quan

Trò chơi chiến lược phân bổ tài nguyên theo lượt. Mỗi lượt, các đội chọn một trong ba bể tài nguyên. Điểm của mỗi bể được chia đều cho các đội cùng chọn. Đội nào tích lũy nhiều điểm nhất sau tất cả các lượt sẽ thắng.

---

## 2. Actors

| Actor | Mô tả |
|-------|-------|
| **Admin** | Người tạo và điều hành phòng. Đăng nhập bằng email/password qua Supabase Auth. |
| **Team (User)** | Đại diện một đội chơi. Không cần tài khoản, định danh bằng session token lấy từ localStorage hoặc query param trên URL. |

---

## 3. Database Schema

### 3.1 Bảng `admins`
> Quản lý bởi Supabase Auth — không cần tạo bảng riêng.  
> Dùng `auth.users` với email/password.

### 3.2 Bảng `rooms`

```sql
create table rooms (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,          -- mã phòng 6 ký tự, tự sinh
  admin_id        uuid references auth.users(id), -- admin sở hữu phòng
  current_round   integer default 0,             -- round hiện tại (0 = chưa bắt đầu)
  status          text default 'waiting',        -- waiting | playing | revealing
  countdown_end   timestamptz,                   -- thời điểm hết countdown
  created_at      timestamptz default now()
);
```

**Status flow:**
```
waiting → playing → revealing → waiting → playing → ... (vô tận)
```

- `waiting`: phòng mới tạo hoặc vừa kết thúc một lượt, chờ admin start
- `playing`: đang đếm ngược, team đang chọn
- `revealing`: countdown hết, admin đang xem popup kết quả

### 3.3 Bảng `teams`

```sql
create table teams (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid references rooms(id),
  name          text not null,
  score         integer default 0,
  session_token text unique not null,  -- UUID tự sinh khi join, lưu vào localStorage và có thể truyền qua URL
  created_at    timestamptz default now(),

  constraint max_teams_per_room check (true) -- enforce ở application layer (tối đa 4 đội)
);
```

**Constraint tối đa 4 đội:** Kiểm tra ở application layer trước khi insert — query count teams theo room_id, nếu >= 4 thì từ chối.

### 3.4 Bảng `selections`

```sql
create table selections (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid references rooms(id),
  team_id       uuid references teams(id),
  round_number  integer not null,
  resource      text not null check (resource in ('gold', 'oil', 'labor')),
  is_default    boolean default false,  -- true nếu là auto-insert vàng (team offline)
  created_at    timestamptz default now(),

  unique(team_id, round_number)  -- mỗi đội chỉ chọn 1 lần mỗi lượt
);
```

---

## 4. Business Rules

### 4.1 Bể tài nguyên

| Tài nguyên | `resource` value | Tổng điểm/lượt |
|-----------|-----------------|---------------|
| Vàng | `gold` | 180 |
| Dầu mỏ | `oil` | 320 |
| Lao động | `labor` | 450 |

**Công thức tính điểm mỗi lượt:**

```
điểm_đội = tổng_điểm_bể / số_đội_cùng_chọn_bể_đó
```

**Ví dụ:** 3 đội cùng chọn `labor` → mỗi đội được 450 / 3 = 150 điểm.

Điểm là số nguyên, **làm tròn xuống** (floor) nếu không chia hết.

### 4.2 Auto-chọn vàng (team offline)

Khi countdown hết, có thể một số team không chọn (offline). Luồng xử lý:

1. Frontend của mỗi team chạy timer local theo `countdown_end`.
2. Khi timer về 0, **team client tự gọi insert** `resource = 'gold'`, `is_default = true` nếu chưa có selection cho round hiện tại. Dùng `upsert` để tránh lỗi duplicate.
3. Nếu team offline (không thực hiện được bước 2), admin sẽ xử lý ở bước tiếp theo.
4. Khi admin mở popup reveal (sau khi room chuyển sang `status = 'revealing'`):
   - Query tất cả teams trong phòng.
   - Query tất cả selections của round hiện tại.
   - Các team **chưa có selection** → hiển thị "Vàng (không chọn)" trên UI.
5. Khi admin bấm **nút X đóng popup**:
   - Insert `resource = 'gold'`, `is_default = true` cho tất cả team chưa có selection (ignore nếu đã có).
   - Tính điểm và cộng vào `teams.score` cho tất cả đội.
   - Cập nhật `rooms.status = 'waiting'` (chờ admin start lượt tiếp).

### 4.3 Tính điểm và cập nhật score

Việc tính điểm xảy ra **duy nhất một lần** khi admin đóng popup reveal:

```
1. Lấy toàn bộ selections của round hiện tại (sau khi đã insert default)
2. Group by resource
3. Tính điểm theo công thức
4. UPDATE teams SET score = score + calculated_points WHERE id = team_id
```

Thực hiện ở client (admin) hoặc Supabase Edge Function đều được.

---

## 5. Luồng chi tiết

### 5.1 Admin: Đăng ký / Đăng nhập

```
Admin → nhập email + password
     → Supabase Auth signInWithPassword()
     → Redirect vào dashboard
```

Một admin có thể tạo **nhiều phòng**. Mỗi phòng thuộc về một admin duy nhất.

### 5.2 Admin: Tạo phòng

```
Admin bấm "Tạo phòng mới"
  → Sinh mã phòng 6 ký tự ngẫu nhiên (uppercase alphanumeric)
  → INSERT rooms (code, admin_id, status='waiting')
  → Redirect vào trang quản lý phòng
```

### 5.3 Team: Join phòng

```
User nhập (tên đội + mã phòng)
  → Query rooms WHERE code = input
  → Nếu không tìm thấy → báo lỗi "Phòng không tồn tại"
  → Nếu tìm thấy → count teams WHERE room_id = room.id
  → Nếu count >= 4 → báo lỗi "Phòng đã đủ 4 đội"
  → INSERT teams (room_id, name, session_token = crypto.randomUUID())
  → localStorage.setItem('team_session', session_token)
  → Redirect sang /play?token={session_token}   -- token luôn có trên URL sau khi join
  → Vào trang chờ của team
```

**Lưu ý:** Team có thể join khi `status = 'playing'` (đang chơi), nhưng sẽ không thể chọn cho round hiện tại nếu round đã bắt đầu (countdown đang chạy). Team sẽ tham gia từ round tiếp theo.

### 5.4 Team: Load lại trang (session recovery)

Token được resolve theo thứ tự ưu tiên:

```
Khi mở trang:
  1. Đọc query param: ?token=xxx trên URL
  2. Nếu không có → đọc localStorage.getItem('team_session')
  3. Nếu cả hai đều không có → show màn hình join

Sau khi có token (từ bất kỳ nguồn nào):
  → query teams WHERE session_token = token
    → Nếu không tìm thấy → báo lỗi "Link không hợp lệ", show màn hình join
    → Nếu tìm thấy:
        → Ghi token vào localStorage (đồng bộ nếu vào bằng URL)
        → Cập nhật URL thành /play?token={token} (nếu chưa có)
        → Load trạng thái phòng hiện tại, vào đúng màn hình
```

**Ưu tiên query param** cho phép các use case sau:
- Admin tạo link có sẵn token gửi cho từng đội qua chat → đội mở link là vào thẳng phòng, không cần nhập gì.
- Đội muốn chơi trên nhiều tab/thiết bị → copy URL (đã có token) sang tab/máy khác.
- Reload trang: URL vẫn giữ token → không cần đọc localStorage.

**Quan trọng:** Nếu mất cả URL lẫn localStorage → phải join lại như team mới (nếu phòng còn slot).

### 5.5 Admin: Start / Restart Countdown

```
Admin bấm "Bắt đầu lượt" hoặc "Restart":
  → UPDATE rooms SET
      current_round = current_round + 1,  -- (Start) hoặc giữ nguyên (Restart)
      status = 'playing',
      countdown_end = now() + interval '30 seconds'
    WHERE id = room.id

Realtime → tất cả team clients nhận UPDATE
         → Hiện 3 nút lựa chọn
         → Bắt đầu chạy timer local
```

**Phân biệt Start vs Restart:**
- **Start lượt mới:** `current_round += 1` — selections cũ của round trước không ảnh hưởng, 3 nút hiện vì round mới.
- **Restart cùng lượt:** `current_round` **giữ nguyên**, xóa selections của round hiện tại trước khi update rooms → 3 nút hiện lại.

> **Business rule Restart:** Trước khi UPDATE rooms, phải DELETE selections WHERE room_id = room.id AND round_number = current_round. Điểm của round này chưa được tính (vì popup chưa đóng) nên an toàn để xóa.

### 5.6 Team: Chọn tài nguyên

```
Team thấy 3 nút: [Vàng] [Dầu mỏ] [Lao động]
  → Bấm 1 nút
  → INSERT selections (room_id, team_id, round_number, resource)
  → Nếu insert thành công → ẩn 3 nút, hiện "Đã chọn: [tên tài nguyên]"
  → Nếu duplicate (đã chọn rồi) → ignore (UI đã ẩn nút)
```

**Khi nào 3 nút hiện:**
- Khi nhận realtime event `rooms UPDATE` với `status = 'playing'` và `current_round` thay đổi (lượt mới).
- Khi load trang và room đang `status = 'playing'` và team chưa có selection cho round hiện tại.

**Khi nào 3 nút ẩn:**
- Sau khi team đã insert selection thành công.
- Khi `status` chuyển sang `revealing` hoặc `waiting`.

### 5.7 Hết Countdown → Reveal

```
Khi countdown_end đến:
  1. [Mỗi team client] tự insert default gold nếu chưa chọn:
       UPSERT selections (room_id, team_id, current_round, 'gold', is_default=true)
       ON CONFLICT (team_id, round_number) DO NOTHING

  2. [Admin client] timer về 0:
       UPDATE rooms SET status = 'revealing' WHERE id = room.id
       → Realtime broadcast → mọi client biết

  3. [Admin] Popup hiện ra:
       - Danh sách từng đội + lựa chọn của họ round này
       - Team chưa có selection → hiển thị "Vàng (không chọn)"
       - Không tính điểm lúc này

  4. [Admin] Bấm X đóng popup:
       a. INSERT default gold cho các team chưa có selection (is_default=true)
       b. Tính điểm theo công thức
       c. UPDATE teams.score cho từng đội
       d. UPDATE rooms SET status = 'waiting' WHERE id = room.id
       → Realtime → team clients chuyển về màn hình chờ
```

### 5.8 Admin: Xem Leaderboard & Lịch sử

Leaderboard (realtime, cập nhật sau mỗi lượt):
```sql
SELECT * FROM teams WHERE room_id = :roomId ORDER BY score DESC;
```

Lịch sử lựa chọn:
```sql
SELECT selections.*, teams.name
FROM selections
JOIN teams ON selections.team_id = teams.id
WHERE selections.room_id = :roomId
ORDER BY round_number, teams.name;
```

---

## 6. Realtime Subscriptions

### Team client subscribe:
```javascript
supabase.channel('room-' + roomId)
  .on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}`
  }, handleRoomUpdate)
  .subscribe();
```

**Xử lý `handleRoomUpdate`:**

| status | current_round thay đổi? | Action trên UI team |
|--------|------------------------|---------------------|
| `playing` | Tăng so với trước | Hiện 3 nút (lượt mới) |
| `playing` | Giữ nguyên (restart) | Hiện 3 nút (nếu đã chọn: ẩn selection cũ) |
| `revealing` | — | Ẩn 3 nút, hiện "Đang chờ kết quả..." |
| `waiting` | — | Hiện màn hình chờ admin start |

### Admin client subscribe:
- Subscribe room updates để sync trạng thái.
- Subscribe teams updates để cập nhật leaderboard realtime.

---

## 7. RLS (Row Level Security)

```sql
-- Rooms: chỉ admin sở hữu mới được UPDATE
CREATE POLICY "Admin manages own rooms" ON rooms
  FOR ALL USING (admin_id = auth.uid());

-- Teams: ai cũng có thể INSERT (join phòng), chỉ đọc trong cùng room
CREATE POLICY "Anyone can join" ON teams
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Read teams in room" ON teams
  FOR SELECT USING (true);

-- Selections: team chỉ insert được của chính mình (validate bằng session_token ở app layer)
CREATE POLICY "Anyone can insert selection" ON selections
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Read selections in room" ON selections
  FOR SELECT USING (true);
```

> **Lưu ý:** Vì team không dùng Supabase Auth, RLS cho teams/selections được relax. Bảo mật chính dựa vào `session_token` unique và validate ở application layer. Nếu cần bảo mật cao hơn, implement Supabase Edge Function để validate token trước khi insert.

---

## 8. Màn hình & Components

### Admin

| Màn hình | Mô tả |
|---------|-------|
| Login | Email/password form |
| Dashboard | Danh sách phòng đã tạo, nút "Tạo phòng mới" |
| Room Manager | Hiện mã phòng, danh sách team đã join, trạng thái, nút Start/Restart, Leaderboard, Lịch sử |
| Reveal Popup | Bảng lựa chọn của từng đội trong round vừa xong. Nút X để đóng + tính điểm. |

### Team (User)

| Màn hình | Mô tả |
|---------|-------|
| Join | Nhập tên đội + mã phòng |
| Waiting Room | Hiện tên đội, mã phòng, danh sách team trong phòng, chờ admin start |
| Playing | Countdown timer + 3 nút chọn tài nguyên (ẩn sau khi chọn) |
| Selected | Hiện "Đã chọn: [tài nguyên]", chờ admin reveal |
| Revealing | Hiện "Đang chờ kết quả..." |

---

## 9. Edge Cases & Validations

| Tình huống | Xử lý |
|-----------|-------|
| Join phòng đã đủ 4 đội | Báo lỗi, không insert |
| Join phòng không tồn tại | Báo lỗi |
| Tên đội trùng trong cùng phòng | Cho phép (không unique theo room) |
| Team chọn 2 lần (double click) | `unique(team_id, round_number)` constraint chặn ở DB |
| Team offline khi countdown hết | Admin insert default gold khi đóng popup |
| Admin restart sau team đã chọn | DELETE selections của round hiện tại trước khi restart |
| Mất localStorage nhưng còn URL | Vào lại bình thường qua query param, localStorage được ghi lại |
| Mất cả URL lẫn localStorage | Phải join lại như team mới (nếu phòng còn slot) |
| Admin đóng tab giữa chừng | Phòng vẫn còn trong DB, admin login lại vào dashboard thấy phòng |
| Cộng điểm 2 lần (admin bấm X 2 lần) | Kiểm tra status trước khi tính điểm: chỉ tính khi `status = 'revealing'` |

---

## 10. Deployment

| Layer | Platform | Ghi chú |
|-------|---------|---------|
| Frontend | Vercel | Connect GitHub repo, auto-deploy |
| Backend/DB | Supabase | Free tier đủ dùng cho demo/MVP |
| Auth | Supabase Auth | Email/password cho admin |
| Realtime | Supabase Realtime | Postgres changes subscription |

**Environment variables cần set trên Vercel:**
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...
```