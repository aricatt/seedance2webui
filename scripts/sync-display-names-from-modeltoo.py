#!/usr/bin/env python3
"""
批量将 ModelToo 用户的 display_name（无则用 username）同步到 SD SQLite users.display_name。
不依赖 better-sqlite3 / Node，避免 Windows 下 .node 被进程占用无法 rebuild。

用法:
  python scripts/sync-display-names-from-modeltoo.py           # 执行
  python scripts/sync-display-names-from-modeltoo.py --dry-run   # 仅预览
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
DB_PATH = ROOT / "server" / "data" / "seedance.db"
DISPLAY_NAME_MAX = 120


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    text = path.read_text(encoding="utf-8", errors="ignore")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        env[k] = v
    return env


def clamp_display_name(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    return s[:DISPLAY_NAME_MAX] if len(s) > DISPLAY_NAME_MAX else s


def mt_display_to_save(u: dict) -> str:
    dn = str(u.get("display_name") or u.get("displayName") or "").strip()
    if dn:
        return clamp_display_name(dn)
    return clamp_display_name(str(u.get("username") or "").strip())


def expand_login_candidates(member: dict) -> list[str]:
    """与 modelTooLocalUserMatch.findLocalUserIdForModelTooMember 候选一致"""
    keys = ("email", "username", "user_name", "userName", "display_name", "displayName")
    candidates: list[str] = []
    for k in keys:
        v = member.get(k)
        if isinstance(v, str) and v.strip():
            candidates.append(v.strip())
    expanded: list[str] = []
    for t in candidates:
        expanded.append(t)
        if "@" in t:
            expanded.append(t.split("@", 1)[0])
    seen: set[str] = set()
    uniq: list[str] = []
    for x in expanded:
        x = x.strip()
        if not x:
            continue
        low = x.lower()
        if low not in seen:
            seen.add(low)
            uniq.append(x)
    return uniq


def find_local_user_id(conn: sqlite3.Connection, member: dict) -> int | None:
    keys = expand_login_candidates(member)
    if not keys:
        return None
    cur = conn.cursor()
    for key in keys:
        row = cur.execute(
            "SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1",
            (key,),
        ).fetchone()
        if row:
            return int(row[0])
    return None


def ensure_display_name_column(conn: sqlite3.Connection) -> None:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "display_name" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
        conn.commit()
        print("[db] 已添加列 users.display_name")


def get_admin_token(base: str, env: dict[str, str]) -> str:
    tok = (env.get("MODELTOO_ADMIN_TOKEN") or "").strip()
    if len(tok) > 20:
        return tok
    user = (env.get("MODELTOO_ADMIN_USERNAME") or "").strip()
    pwd = (env.get("MODELTOO_ADMIN_PASSWORD") or "").strip()
    if not user or not pwd:
        raise SystemExit(
            "请在 .env 配置 MODELTOO_ADMIN_TOKEN，或 MODELTOO_ADMIN_USERNAME + MODELTOO_ADMIN_PASSWORD"
        )
    url = base.rstrip("/") + "/api/v1/auth/login"
    body = json.dumps({"username": user, "password": pwd}).encode("utf-8")
    req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        raise SystemExit(f"ModelToo 管理员登录失败 HTTP {e.code}") from e
    except URLError as e:
        raise SystemExit(f"无法连接 ModelToo: {e}") from e
    token = data.get("access_token")
    if not token:
        raise SystemExit("ModelToo 登录响应缺少 access_token")
    return str(token)


def fetch_all_mt_users(base: str, token: str) -> list[dict]:
    items: list[dict] = []
    limit = 100
    skip = 0
    while True:
        url = f"{base.rstrip('/')}/api/v1/admin/users?skip={skip}&limit={limit}"
        req = Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            raise SystemExit(f"拉取 ModelToo 用户列表失败 HTTP {e.code}") from e
        batch = body.get("items") if isinstance(body, dict) else None
        if not isinstance(batch, list):
            batch = []
        items.extend(batch)
        if len(batch) < limit:
            break
        skip += limit
        if skip > 50000:
            break
    return items


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    env = load_env(ENV_PATH)
    base = (env.get("MODELTOO_API_URL") or "").strip().rstrip("/")
    if not base:
        raise SystemExit("未配置 MODELTOO_API_URL")

    if not DB_PATH.exists():
        raise SystemExit(f"数据库不存在: {DB_PATH}")

    token = get_admin_token(base, env)
    mt_users = fetch_all_mt_users(base, token)
    print(f"ModelToo 用户数: {len(mt_users)}")

    conn = sqlite3.connect(str(DB_PATH))
    try:
        ensure_display_name_column(conn)
        cur = conn.cursor()

        mt_total = len(mt_users)
        matched = 0
        updated = 0
        skipped_no_local = 0
        skipped_no_mt_name = 0
        unchanged = 0

        for u in mt_users:
            if not isinstance(u, dict):
                continue
            new_dn = mt_display_to_save(u)
            if not new_dn:
                skipped_no_mt_name += 1
                continue

            lid = find_local_user_id(conn, u)
            if lid is None:
                skipped_no_local += 1
                continue
            matched += 1

            row = cur.execute(
                "SELECT id, email, display_name FROM users WHERE id = ?",
                (lid,),
            ).fetchone()
            if not row:
                continue
            cur_dn = str(row[2] or "").strip()
            if cur_dn == new_dn:
                unchanged += 1
                continue

            email = row[1]
            if dry_run:
                print(
                    f"[dry-run] id={lid} email={email} | "
                    f'display_name: "{cur_dn}" -> "{new_dn}" (MT username={u.get("username")})'
                )
            else:
                cur.execute(
                    "UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
                    (new_dn, lid),
                )
                print(f'已更新 id={lid} ({email}) -> "{new_dn}"')
            updated += 1

        if not dry_run:
            conn.commit()

        print("\n--- 汇总 ---")
        print("ModelToo 用户行数:", mt_total)
        print("匹配到本地用户:", matched)
        print("跳过（MT 无可用展示名）:", skipped_no_mt_name)
        print("跳过（本地无匹配 users.email）:", skipped_no_local)
        print("本地已是目标值:", unchanged)
        print("已写入:" if not dry_run else "将写入（dry-run）:", updated)
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
