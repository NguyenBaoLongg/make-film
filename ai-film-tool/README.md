# AI Film Studio

Dự án AI Film Studio bao gồm 2 phần chính: Frontend (React + Vite) và Backend (Node.js + Express). Dữ liệu được lưu trữ và xác thực bằng Supabase.

## Yêu cầu hệ thống
- Node.js (phiên bản 18+).
- Một tài khoản [Supabase](https://supabase.com/) để tạo database và lưu trữ.

---

## Bước 1: Thiết lập Supabase

1. Truy cập [Supabase](https://supabase.com/), tạo một project mới.
2. Mở mục **SQL Editor** trong Supabase Dashboard.
3. Copy toàn bộ nội dung trong file `supabase/migrations/20260614000000_init.sql` và chạy (Run) để tạo các bảng, policies (RLS), và triggers.
4. Mở mục **Storage**, tạo một bucket mới tên là `film-assets` và chọn Public.
5. Mở mục **Project Settings -> API** để lấy các thông tin sau:
   - **Project URL**
   - **Project API Keys (anon / public)**
   - **Project API Keys (service_role)** *(Lưu ý: Không bao giờ để lộ key này cho frontend)*

---

## Bước 2: Cấu hình biến môi trường (.env)

**1. Cho Frontend:**
Mở file `frontend/.env` và điền thông tin:
```env
VITE_SUPABASE_URL=YOUR_SUPABASE_URL
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

**2. Cho Backend:**
Tạo file `backend/.env` (nếu chưa có) hoặc điền trực tiếp vào `backend/src/config/env.ts`, nhưng tốt nhất là tạo file `backend/.env`:
```env
PORT=3000
SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=film-assets
REDIS_URL=redis://localhost:6379
```

---

## Bước 3: Chạy Backend

Mở terminal mới:
```bash
cd backend
npm install
npm run dev
```
Backend sẽ chạy tại `http://localhost:3000`.

---

## Bước 4: Chạy Frontend

Mở một terminal khác:
```bash
cd frontend
npm install
npm run dev
```
Frontend sẽ chạy tại `http://localhost:5173`. 
Truy cập link này trên trình duyệt để sử dụng ứng dụng.
