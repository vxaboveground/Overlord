import argparse
import os
import random
import sqlite3
import string
import time
import uuid
from typing import Iterable, Tuple

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  hwid TEXT,
  role TEXT,
  host TEXT,
  os TEXT,
  arch TEXT,
  version TEXT,
  user TEXT,
  monitors INTEGER,
  country TEXT,
  last_seen INTEGER,
  online INTEGER,
  ping_ms INTEGER,
  cpu TEXT,
  gpu TEXT,
  ram TEXT,
  battery_percent INTEGER,
  battery_charging INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  elevation TEXT,
  enrollment_status TEXT NOT NULL DEFAULT 'approved',
  bookmarked INTEGER NOT NULL DEFAULT 0,
  notifications_muted INTEGER NOT NULL DEFAULT 0
);
"""

ROLES = ["client", "viewer"]
ARCHES = ["amd64", "arm64", "x86", "arm"]
OS_PROFILES = [
    {
        "os": "Windows 11 Pro 23H2",
        "arches": ["amd64", "arm64"],
        "cpus": ["Intel(R) Core(TM) i7-13700H", "Intel(R) Core(TM) i9-13900K", "AMD Ryzen 7 7840U"],
        "gpus": ["NVIDIA GeForce RTX 4070 Laptop GPU", "Intel Iris Xe Graphics", "AMD Radeon 780M"],
        "ram": ["16 GB", "32 GB", "64 GB"],
        "battery": True,
    },
    {
        "os": "Windows 10 Pro 22H2",
        "arches": ["amd64", "x86"],
        "cpus": ["Intel(R) Core(TM) i5-10400", "Intel(R) Core(TM) i7-9700K", "AMD Ryzen 5 3600"],
        "gpus": ["NVIDIA GeForce GTX 1660", "Intel UHD Graphics 630", "AMD Radeon RX 580"],
        "ram": ["8 GB", "16 GB", "32 GB"],
        "battery": False,
    },
    {
        "os": "Ubuntu 24.04.1 LTS",
        "arches": ["amd64", "arm64"],
        "cpus": ["AMD Ryzen 9 7950X", "Intel(R) Core(TM) i7-12700", "Apple M2"],
        "gpus": ["NVIDIA GeForce RTX 3060", "AMD Radeon RX 6700 XT", "llvmpipe"],
        "ram": ["8 GB", "16 GB", "32 GB"],
        "battery": True,
    },
    {
        "os": "Debian GNU/Linux 12 (bookworm)",
        "arches": ["amd64", "arm64"],
        "cpus": ["Intel(R) Xeon(R) CPU E5-2670", "AMD EPYC 7282", "Intel(R) Core(TM) i5-8250U"],
        "gpus": ["virtio_gpu", "Intel UHD Graphics 620", "NVIDIA T400"],
        "ram": ["4 GB", "8 GB", "16 GB"],
        "battery": False,
    },
    {
        "os": "Fedora Linux 40 (Workstation Edition)",
        "arches": ["amd64"],
        "cpus": ["AMD Ryzen 7 5800X", "Intel(R) Core(TM) Ultra 7 155H"],
        "gpus": ["AMD Radeon RX 6800", "Intel Arc Graphics"],
        "ram": ["16 GB", "32 GB"],
        "battery": True,
    },
    {
        "os": "Arch Linux",
        "arches": ["amd64"],
        "cpus": ["AMD Ryzen 5 7600X", "Intel(R) Core(TM) i5-13600K"],
        "gpus": ["NVIDIA GeForce RTX 3080", "AMD Radeon RX 7900 XT"],
        "ram": ["16 GB", "32 GB", "64 GB"],
        "battery": False,
    },
    {
        "os": "Kali GNU/Linux Rolling",
        "arches": ["amd64", "arm64"],
        "cpus": ["Intel(R) Core(TM) i7-8650U", "AMD Ryzen 5 PRO 4650U"],
        "gpus": ["Intel UHD Graphics 620", "VMware SVGA II Adapter"],
        "ram": ["4 GB", "8 GB", "16 GB"],
        "battery": True,
    },
    {
        "os": "Linux Mint 22",
        "arches": ["amd64"],
        "cpus": ["AMD Ryzen 7 5700U", "Intel(R) Core(TM) i5-1135G7"],
        "gpus": ["AMD Radeon Graphics", "Intel Iris Xe Graphics"],
        "ram": ["8 GB", "16 GB"],
        "battery": True,
    },
    {
        "os": "Red Hat Enterprise Linux 9.4",
        "arches": ["amd64"],
        "cpus": ["Intel(R) Xeon(R) Silver 4210", "AMD EPYC 7313P"],
        "gpus": ["Matrox G200e", "NVIDIA T1000"],
        "ram": ["32 GB", "64 GB", "128 GB"],
        "battery": False,
    },
    {
        "os": "openSUSE Tumbleweed",
        "arches": ["amd64"],
        "cpus": ["AMD Ryzen 9 7900", "Intel(R) Core(TM) i7-13700"],
        "gpus": ["AMD Radeon RX 7600", "Intel Arc A770"],
        "ram": ["16 GB", "32 GB"],
        "battery": False,
    },
    {
        "os": "macOS 14.5",
        "arches": ["arm64", "amd64"],
        "cpus": ["Apple M2", "Apple M2 Pro", "Apple M3 Max", "Intel(R) Core(TM) i9-9980HK"],
        "gpus": ["Apple GPU", "AMD Radeon Pro 5500M"],
        "ram": ["8 GB", "16 GB", "32 GB", "64 GB"],
        "battery": True,
    },
]
COUNTRIES = [
    "US",
    "GB",
    "DE",
    "FR",
    "ES",
    "CA",
    "AU",
    "IN",
    "BR",
    "ZA",
    "JP",
    "KR",
    "CN",
    "SG",
    "SE",
    "NO",
    "DK",
    "FI",
    "PL",
    "MX",
]


def random_host() -> str:
    prefix = random.choice(["desk", "laptop", "vm", "srv", "pc"])
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"{prefix}-{suffix}"


def random_user() -> str:
    first = random.choice(
        ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"]
    )
    num = random.randint(1, 9999)
    return f"{first}{num}"


def random_version() -> str:
    return f"{random.randint(0, 5)}.{random.randint(0, 20)}.{random.randint(0, 9)}"


def random_row(now_ms: int, online_rate: float) -> Tuple:
    client_id = uuid.uuid4().hex
    hwid = uuid.uuid4().hex
    role = "client" if random.random() > 0.02 else random.choice(ROLES)
    host = random_host()
    profile = random.choice(OS_PROFILES)
    os_name = profile["os"]
    arch = random.choice(profile.get("arches") or ARCHES)
    version = random_version()
    user = random_user()
    monitors = random.randint(1, 3)
    country = random.choice(COUNTRIES)
    last_seen = now_ms - random.randint(0, 7 * 24 * 60 * 60 * 1000)
    online = 1 if random.random() < online_rate else 0
    ping_ms = random.choice([None, random.randint(10, 400), random.randint(400, 2000)])
    cpu = random.choice(profile["cpus"])
    gpu = random.choice(profile["gpus"])
    ram = random.choice(profile["ram"])
    battery_percent = None
    battery_charging = None
    if profile.get("battery") and random.random() < 0.72:
        battery_percent = random.randint(7, 100)
        battery_charging = 1 if random.random() < 0.38 else 0
    is_admin = 1 if random.random() < 0.22 else 0
    elevation = random.choice(["user", "admin", "system", None])
    if is_admin and elevation == "user":
        elevation = "admin"
    bookmarked = 1 if random.random() < 0.08 else 0
    notifications_muted = 1 if random.random() < 0.05 else 0
    return (
        client_id,
        hwid,
        role,
        host,
        os_name,
        arch,
        version,
        user,
        monitors,
        country,
        last_seen,
        online,
        ping_ms,
        cpu,
        gpu,
        ram,
        battery_percent,
        battery_charging,
        is_admin,
        elevation,
        "approved",
        bookmarked,
        notifications_muted,
    )


def batched_rows(
    count: int, batch_size: int = 500, online_rate: float = 0.6
) -> Iterable[Tuple[Tuple, ...]]:
    now_ms = int(time.time() * 1000)
    batch = []
    for _ in range(count):
        batch.append(random_row(now_ms, online_rate))
        if len(batch) >= batch_size:
            yield tuple(batch)
            batch = []
    if batch:
        yield tuple(batch)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(SCHEMA)
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(clients)").fetchall()
    }
    additions = {
        "cpu": "TEXT",
        "gpu": "TEXT",
        "ram": "TEXT",
        "battery_percent": "INTEGER",
        "battery_charging": "INTEGER",
        "is_admin": "INTEGER NOT NULL DEFAULT 0",
        "elevation": "TEXT",
        "enrollment_status": "TEXT NOT NULL DEFAULT 'approved'",
        "bookmarked": "INTEGER NOT NULL DEFAULT 0",
        "notifications_muted": "INTEGER NOT NULL DEFAULT 0",
    }
    for name, decl in additions.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE clients ADD COLUMN {name} {decl}")


def seed(db_path: str, count: int, truncate: bool, online_rate: float) -> None:
    parent = os.path.dirname(os.path.abspath(db_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        ensure_schema(conn)
        if truncate:
            conn.execute("DELETE FROM clients")
            conn.commit()
        sql = (
            "INSERT INTO clients (id, hwid, role, host, os, arch, version, user, monitors, country, last_seen, online, ping_ms, cpu, gpu, ram, battery_percent, battery_charging, is_admin, elevation, enrollment_status, bookmarked, notifications_muted) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        total = 0
        for batch in batched_rows(count, online_rate=online_rate):
            conn.executemany(sql, batch)
            conn.commit()
            total += len(batch)
            print(f"Inserted {total}/{count}...")
        print(f"Done. Inserted {total} rows into {db_path}")
    finally:
        conn.close()


def resolve_default_db() -> str:
    data_dir = os.getenv("DATA_DIR", "").strip()
    if not data_dir:
        if os.name == "nt" and os.getenv("APPDATA"):
            data_dir = os.path.join(os.environ["APPDATA"], "Overlord")
        else:
            data_dir = "./data"
    return os.path.abspath(os.path.join(data_dir, "overlord.db"))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed fake clients into overlord.db for load testing."
    )
    parser.add_argument(
        "--db",
        default=resolve_default_db(),
        help="Path to overlord.db (default follows server logic: DATA_DIR, then APPDATA/Overlord on Windows, else ./data)",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=100000,
        help="How many rows to insert (default: 100000)",
    )
    parser.add_argument(
        "--truncate", action="store_true", help="Delete existing rows before seeding"
    )
    parser.add_argument(
        "--online-rate",
        type=float,
        default=0.6,
        help="Probability a seeded client is online (0-1, default: 0.6)",
    )
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    print(f"Seeding {args.count} clients into {db_path} (truncate={args.truncate})")
    seed(db_path, args.count, args.truncate, args.online_rate)


if __name__ == "__main__":
    main()
