import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def checksum(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


class Repository:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir(exist_ok=True)
        self.path = self.root / "analysis.sqlite"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS entities (study TEXT, kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(study,kind,id))")
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, study TEXT, body TEXT NOT NULL)")
            for row in db.execute("SELECT id, body FROM jobs").fetchall():
                job = json.loads(row[1])
                if job["status"] in ("queued", "running", "cancelling"):
                    job.update(status="interrupted", error="Service restarted. Create a new run to retry.", endedAt=now())
                    db.execute("UPDATE jobs SET body=? WHERE id=?", (encoded(job), row[0]))

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def put(self, study, kind, body, mutable=False):
        body = {**body}
        body.setdefault("id", str(uuid.uuid4()))
        body.setdefault("createdAt", now())
        body.update(studyId=study, schemaVersion=1)
        with self.connect() as db:
            if mutable:
                previous = db.execute('SELECT body FROM entities WHERE study=? AND kind=? AND id=?',(study,kind,body['id'])).fetchone()
                if previous:
                    prior = json.loads(previous[0])
                    body['createdAt'] = prior['createdAt']
                    body['revision'] = prior.get('revision',1)+1
                db.execute("INSERT OR REPLACE INTO entities VALUES(?,?,?,?)", (study, kind, body["id"], encoded(body)))
            else:
                db.execute("INSERT INTO entities VALUES(?,?,?,?)", (study, kind, body["id"], encoded(body)))
        return body

    def get(self, study, kind, identity):
        with self.connect() as db:
            row = db.execute("SELECT body FROM entities WHERE study=? AND kind=? AND id=?", (study, kind, identity)).fetchone()
        if row is None:
            raise ValueError(f"{kind} record not found")
        return json.loads(row[0])

    def list(self, study=None, kind=None):
        conditions, args = [], []
        for field, value in (("study", study), ("kind", kind)):
            if value is not None:
                conditions.append(f"{field}=?")
                args.append(value)
        query = "SELECT kind,body FROM entities" + (" WHERE " + " AND ".join(conditions) if conditions else "") + " ORDER BY rowid"
        with self.connect() as db:
            return [(row[0], json.loads(row[1])) for row in db.execute(query, args)]

    def job(self, identity, patch=None):
        with self.connect() as db:
            row = db.execute("SELECT body FROM jobs WHERE id=?", (identity,)).fetchone()
            if row is None:
                raise ValueError("Job not found")
            body = json.loads(row[0])
            if patch:
                # A worker's progress update must not undo a cancellation.
                if body["status"] in ("cancelling", "cancelled") and patch.get("status") == "running":
                    patch = {k: v for k, v in patch.items() if k != "status"}
                body.update(patch)
                db.execute("UPDATE jobs SET body=? WHERE id=?", (encoded(body), identity))
        return body

    def add_job(self, study, kind, parameters):
        body = dict(id=str(uuid.uuid4()), studyId=study, kind=kind, parameters=parameters,
                    status="queued", progress=0, createdAt=now(), codeVersion="geobound-analysis-1")
        with self.connect() as db:
            db.execute("INSERT INTO jobs VALUES(?,?,?)", (body["id"], study, encoded(body)))
        return body

    def jobs(self, study):
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute("SELECT body FROM jobs WHERE study=? ORDER BY rowid DESC", (study,))]

    def import_entities(self, study, records):
        # Validate the entire archive before this single transaction is called.
        with self.connect() as db:
            for kind, body in records:
                body = {**body, "studyId": study}
                if kind == "study":
                    body["id"] = study
                db.execute("INSERT INTO entities VALUES(?,?,?,?)", (study, kind, body["id"], encoded(body)))


class Cancelled(Exception):
    pass
