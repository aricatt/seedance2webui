import sqlite3

db = sqlite3.connect(r"d:\Ari\Src\ModelTooSD\server\data\seedance.db")
db.row_factory = sqlite3.Row

def like(url, *subs):
    u = (url or "").lower()
    return any(s in u for s in subs)

rows = db.execute("""
  SELECT id, persist_video_key, persist_video_tos_url, video_url, download_status, status
  FROM tasks
  WHERE task_kind = 'output' AND status = 'done'
""").fetchall()

total = len(rows)
has_key = sum(1 for r in rows if (r["persist_video_key"] or "").strip())
has_pvtu = sum(1 for r in rows if (r["persist_video_tos_url"] or "").strip().startswith("http"))
has_vu = sum(1 for r in rows if (r["video_url"] or "").strip().startswith("http"))
ark_only = sum(
    1
    for r in rows
    if not (r["persist_video_key"] or "").strip()
    and not (r["persist_video_tos_url"] or "").strip()
    and like(r["video_url"], "ark-acg", "doubao-seedance")
)
yun_lib = sum(
    1
    for r in rows
    if like(r["persist_video_tos_url"] or r["video_url"], "yun-lib")
    or (r["persist_video_key"] or "").strip()
)
# 1432 sample
t = db.execute("SELECT * FROM tasks WHERE id=1432").fetchone()
print("done output tasks:", total)
print("persist_video_key set:", has_key)
print("persist_video_tos_url http:", has_pvtu)
print("video_url http:", has_vu)
print("ark-only (no persist_*):", ark_only)
print("yun-lib key or url:", yun_lib)
print("--- task 1432 ---")
for k in ("persist_video_key", "persist_video_tos_url", "persist_cover_key", "persist_cover_tos_url"):
    print(k, repr(t[k] if t else None))
vu = (t["video_url"] or "") if t else ""
print("video_url host:", vu.split("/")[2] if vu.startswith("http") else "(none)")
