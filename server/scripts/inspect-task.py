import sqlite3
import json
import sys

task_id = sys.argv[1] if len(sys.argv) > 1 else "1432"
db = sqlite3.connect(r"d:\Ari\Src\ModelTooSD\server\data\seedance.db")
db.row_factory = sqlite3.Row
cols = [r[1] for r in db.execute("PRAGMA table_info(tasks)")]
row = db.execute(
    "SELECT * FROM tasks WHERE id = ? OR item_id LIKE ? LIMIT 1",
    (int(task_id) if task_id.isdigit() else -1, f"%{task_id}%"),
).fetchone()
if not row:
    print("not found")
    sys.exit(1)
data = {k: row[k] for k in cols if row[k] is not None}
print(json.dumps(data, indent=2, ensure_ascii=False))
